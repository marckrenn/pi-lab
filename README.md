# pi-ab-wip

Work-in-progress **pi A/B conductor extension** for transparent tool interception, lane isolation, winner selection, and run telemetry.

## What it does (6-stage pipeline)

- [Stage 1: Intercept](#stage-1-intercept)
- [Stage 2: Fork lanes](#stage-2-fork-lanes)
- [Stage 3: Execute strategy](#stage-3-execute-strategy)
- [Stage 4: Score and select winner](#stage-4-score-and-select-winner)
- [Stage 5: Apply result](#stage-5-apply-result)
- [Stage 6: Persist telemetry](#stage-6-persist-telemetry)

## Quick start

```bash
cd /Users/marckrenn/Documents/projects/pi-ab-wip
pi -e ./pi-extension/ab/index.ts
```

Inside pi:

```text
/ab wizard                     # interactive setup; writes experiment + grading prompt scaffold
/ab status                     # list loaded experiments and source paths
/ab validate                   # check config errors/warnings
/ab gc --keep-last 10          # preview cleanup (dry-run)
/ab gc --keep-last 10 --force  # execute cleanup
```

---

## Stage 1: Intercept

The tool call is matched by:

- `target_tool` (the tool name this experiment intercepts)
- optional `trigger` gates:
  - `sample_rate`
  - `when_path_regex`
  - `when_oldtext_min_chars`
  - `cooldown_ms`

`trigger.tool` is intentionally removed. Tool routing is defined by `target_tool` only.

## Stage 2: Fork lanes

Each lane runs in an isolated git worktree. Lane side effects are sandboxed from each other and from the main workspace.

## Stage 3: Execute strategy

| Strategy | Lane input | Typical harness | Protocol | Use case |
|---|---|---|---|---|
| `fixed_args` | Same intercepted args for all lanes | `direct` | Lane calls intercepted tool directly | Apples-to-apples implementation comparison |
| `lane_single_call` | `{ task, context?, constraints? }` | `pi_prompt` | Exactly one target-tool call + `LANE_DONE` | One-call discipline with lane-specific argument schemas |
| `lane_multi_call` | `{ task, context?, constraints? }` | `pi_prompt` | Multi-step lane flow + strict final JSON | Lane-level replanning/tool chaining |

`lane_harness` is inferred from strategy. Explicit config field is removed.
(Advanced override remains available via `PI_AB_LANE_HARNESS=direct|pi_prompt`.)

## Stage 4: Score and select winner

| Winner mode | Behavior | Use case |
|---|---|---|
| `shadow` | **Always selects the primary lane** for mergeback | Safety-first rollout/passive benchmarking |
| `deterministic` | Formula/tie-break ranking from measurable metrics | Low-cost, explainable selection |
| `grading` | LLM grading decides winner | Quality-first semantic selection |
| `hybrid` | Combines deterministic and grading signals | Balance objective metrics + semantic quality |

### Grading fallback policy

When grading fails (timeout, invalid schema, no usable winner, etc.), `failure_policy.on_grading_failure` controls fallback behavior:
- `fallback_deterministic_then_shadow`
- `fallback_shadow`

## Stage 5: Apply result

Winner patch/output is applied back to the main workspace (`git apply`, then `--3way` fallback when needed).

## Stage 6: Persist telemetry

Artifacts are written to:

`~/.pi/agent/ab/runs/<project>/<run-id>/`

Common files:
- `run.json`
- `lanes/{id}.json`
- `artifacts/grading-input.json`
- `artifacts/grading-output.json`
- `artifacts/grading-raw-output-*.md`
- `lanes/<id>/target-before.md`
- `lanes/<id>/target-after.md`
- `sessions/...` (prompt harness runs)

---

## Config file UX (annotated JSONC)

The schema is the same; this layout is grouped by intent for readability.

```jsonc
{
  // ─────────────────────────────────────────────────────────────
  // Identity + routing
  // ─────────────────────────────────────────────────────────────
  "id": "edit-lanes-v1",
  "enabled": true,
  "target_tool": "edit",

  // ─────────────────────────────────────────────────────────────
  // Trigger gates (optional)
  // ─────────────────────────────────────────────────────────────
  "trigger": {
    "sample_rate": 1,
    "when_path_regex": "^fixtures/ab-test/",
    "when_oldtext_min_chars": 1,
    "cooldown_ms": 0
  },

  // ─────────────────────────────────────────────────────────────
  // Execution
  // ─────────────────────────────────────────────────────────────
  "execution_strategy": "fixed_args", // fixed_args | lane_single_call | lane_multi_call
  "timeout_ms": 15000,

  // ─────────────────────────────────────────────────────────────
  // Winner selection
  // ─────────────────────────────────────────────────────────────
  "winner_mode": "deterministic",     // shadow | deterministic | grading | hybrid
  "selection": {
    "deterministic": {
      "objective": "min({latency_ms} + {error} * 100000 + {timeout} * 100000)",
      "tie_breakers": ["max(success)", "min(total_tokens)"]
    },
    "hybrid": {
      "mode": "llm_score",            // llm_tiebreaker | llm_score
      "deterministic_weight": 0.7,
      "llm_weight": 0.3,
      "final_objective": "max({deterministic_score} * 0.7 + {llm_score} * 0.3)",
      "final_tie_breakers": ["max(llm_score)"]
    }
  },

  // ─────────────────────────────────────────────────────────────
  // Grading
  // ─────────────────────────────────────────────────────────────
  "grading": {
    "execution": "process",
    "timeout_ms": 12000,
    "prompt_file": "./.pi/ab/prompts/grade-default.md",
    "include": { "tool_calls": true }
  },

  // ─────────────────────────────────────────────────────────────
  // Lanes
  // ─────────────────────────────────────────────────────────────
  "lanes": [
    { "id": "A", "primary": false, "extensions": ["./fixtures/ab-test/lanes/edit-perm-a.ts"] },
    { "id": "B", "primary": true,  "extensions": ["./fixtures/ab-test/lanes/edit-perm-b.ts"] },
    { "id": "C", "primary": false, "extensions": ["./fixtures/ab-test/lanes/edit-perm-c.ts"] }
  ],

  // ─────────────────────────────────────────────────────────────
  // Failure policy
  // ─────────────────────────────────────────────────────────────
  "failure_policy": {
    "on_lane_timeout": "exclude_continue",
    "on_lane_crash": "exclude_continue",
    "on_grading_failure": "fallback_deterministic_then_shadow",
    "on_winner_apply_failure": "fallback_primary_then_fail",
    "all_lanes_failed": "fallback_primary"
  },

  // ─────────────────────────────────────────────────────────────
  // Debug
  // ─────────────────────────────────────────────────────────────
  "debug": false,
  "debug_ui": "none"
}
```

### Minimal mode snippets

**LLM-only winner selection:**

```json
{ "winner_mode": "grading" }
```

**Shadow mode (always primary lane wins):**

```json
{ "winner_mode": "shadow" }
```

---

## Validation

`/ab validate` reports configuration warnings/errors.

Examples:
- unsupported `execution_strategy`
- missing `target_tool` or `winner_mode`
- legacy keys (`trigger.tool`, `mode`, `lane_harness`) in config
- `when_path_regex` caveat for proxy strategies

Invalid experiments are skipped at runtime.

## Debug controls

Config:
- `"debug": true|false`
- `"debug_ui": "none" | "cmux"`

Env overrides:

```bash
PI_AB_DEBUG_UI=cmux
PI_AB_KEEP_PANES=1
PI_AB_DEBUG_JSON=1
PI_AB_LANE_HARNESS=direct|pi_prompt
```

## Project files

- `pi-extension/ab/index.ts` — interception wiring and command registration
- `pi-extension/ab/config.ts` — experiment loading, validation, matching
- `pi-extension/ab/runner.ts` — lane execution/worktree handling
- `pi-extension/ab/selection.ts` — deterministic scoring/ranking
- `pi-extension/ab/winner.ts` — winner mode logic
- `pi-extension/ab/grading.ts` — grader process orchestration
- `pi-extension/ab/wizard.ts` — setup wizard
- `pi-extension/ab/gc.ts` — retention and cleanup

## Local checks

```bash
npm run typecheck
npm test
```
