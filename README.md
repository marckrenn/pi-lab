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
/ab validate                   # show config warnings/errors
/ab gc --keep-last 10          # preview cleanup (dry-run)
/ab gc --keep-last 10 --force  # execute cleanup
```

---

## Stage 1: Intercept

An experiment activates only when the incoming tool call matches its trigger policy.

### `target_tool` vs `trigger.tool`

- `target_tool`: the tool this experiment is designed to intercept and run across lanes.
- `trigger.tool`: the tool name used by the trigger matcher.

In current runtime behavior, these should be the same for a matching experiment. If they differ, validation warns and the experiment typically will not match.

### Trigger gates

| Field | Meaning |
|---|---|
| `sample_rate` | Probability gate (0..1) for whether the experiment runs on a call |
| `when_path_regex` | Optional path regex gate (mostly useful for `fixed_args` flows with `args.path`) |
| `when_oldtext_min_chars` | Optional minimum oldText length gate (edit-like flows) |
| `cooldown_ms` | Minimum delay between runs of the same experiment |

If no valid enabled experiment matches, the call proceeds normally.

## Stage 2: Fork lanes

Each lane runs in an isolated git worktree so lane side effects are fully separated from each other and from the main workspace.

## Stage 3: Execute strategy

| Strategy | What lanes receive | Typical harness | Protocol | Use case |
|---|---|---|---|---|
| `fixed_args` | Same intercepted args for all lanes | `direct` | Lane calls intercepted tool directly | Fast apples-to-apples implementation comparison |
| `lane_single_call` | `{ task, context?, constraints? }` | `pi_prompt` | Exactly one target-tool call + `LANE_DONE` | One-call discipline with lane-specific argument schemas |
| `lane_multi_call` | `{ task, context?, constraints? }` | `pi_prompt` | Multi-step lane flow with strict final JSON | Lane-level replanning and tool chaining for harder tasks |

## Stage 4: Score and select winner

| Winner selection mode | Behavior | Use case |
|---|---|---|
| `shadow` | Keep primary lane output | Safety-first rollout/passive benchmarking |
| `deterministic` | Formula/tie-break ranking from measurable metrics | Low-cost, explainable selection |
| `grading` | LLM grader decides winner (fallback policy if grading fails) | Quality-first semantic selection |
| `hybrid` | Combine deterministic and grading signals | Balance objective metrics and semantic quality |

### LLM-only winner selection

Use `mode: "grading"` when winner selection should be decided by the LLM grader (with configured fallback on grader failure).

### Why `selection.deterministic` and `selection.hybrid` are split

They control different layers:

- `selection.deterministic`: defines the baseline metric ranking (`objective` + `tie_breakers`).
- `selection.hybrid`: defines how LLM grading is incorporated on top of that baseline.

This keeps deterministic ranking reusable and explicit, and makes hybrid behavior configurable without redefining the whole base ranking model.

#### Hybrid `llm_score` specifics

For `mode: "hybrid"` + `selection.hybrid.mode: "llm_score"`, the final ranking can use:
- `{llm_score}` (0..1 from grader)
- `{deterministic_score}` (normalized deterministic rank)

Example:

```json
{
  "selection": {
    "deterministic": {
      "objective": "min({latency_ms} + {error} * 100000 + {timeout} * 100000)",
      "tie_breakers": ["max(success)"]
    },
    "hybrid": {
      "mode": "llm_score",
      "deterministic_weight": 0.6,
      "llm_weight": 0.4,
      "final_objective": "max({deterministic_score} * 0.6 + {llm_score} * 0.4)",
      "final_tie_breakers": ["max(llm_score)"]
    }
  }
}
```

## Stage 5: Apply result

Winner patch/output is applied back to the main workspace (`git apply`, then `--3way` fallback when needed).

## Stage 6: Persist telemetry

Artifacts are written under:

`~/.pi/agent/ab/runs/<project>/<run-id>/`

Typical files:
- `run.json`
- `lanes/{id}.json`
- `artifacts/grading-input.json`
- `artifacts/grading-output.json`
- `artifacts/grading-raw-output-*.md`
- `lanes/<id>/target-before.md`
- `lanes/<id>/target-after.md`
- `sessions/...` (for prompt-based harness runs)

---

## Annotated experiment config (JSONC)

```jsonc
{
  "id": "edit-lanes-v1",                     // unique experiment id
  "enabled": true,

  "target_tool": "edit",                     // tool intercepted and executed across lanes
  "trigger": {
    "tool": "edit",                          // trigger matcher tool name (should match target_tool)
    "sample_rate": 1,                          // 0..1 sampling gate
    "when_path_regex": "^fixtures/ab-test/", // optional path filter
    "when_oldtext_min_chars": 1,               // optional oldText-size filter
    "cooldown_ms": 0                           // optional minimum interval between runs
  },

  "mode": "deterministic",                   // shadow | deterministic | grading | hybrid
  "execution_strategy": "fixed_args",        // fixed_args | lane_single_call | lane_multi_call

  "lanes": [
    { "id": "A", "primary": false, "extensions": ["./fixtures/ab-test/lanes/edit-perm-a.ts"] },
    { "id": "B", "primary": true,  "extensions": ["./fixtures/ab-test/lanes/edit-perm-b.ts"] },
    { "id": "C", "primary": false, "extensions": ["./fixtures/ab-test/lanes/edit-perm-c.ts"] }
  ],

  "timeout_ms": 15000,
  "lane_harness": "direct",                  // direct (fixed_args) or pi_prompt (proxy strategies)

  "selection": {
    "deterministic": {
      "objective": "min({latency_ms} + {error} * 100000 + {timeout} * 100000)",
      "tie_breakers": ["max(success)", "min(total_tokens)"]
    },
    "hybrid": {
      "mode": "llm_score",                   // llm_tiebreaker | llm_score
      "deterministic_weight": 0.7,
      "llm_weight": 0.3,
      "final_objective": "max({deterministic_score} * 0.7 + {llm_score} * 0.3)",
      "final_tie_breakers": ["max(llm_score)"]
    }
  },

  "grading": {
    "execution": "process",
    "timeout_ms": 12000,
    "prompt_file": "./.pi/ab/prompts/grade-default.md",
    "include": { "tool_calls": true }        // include lane_tool_calls in grading input
  },

  "failure_policy": {
    "on_lane_timeout": "exclude_continue",
    "on_lane_crash": "exclude_continue",
    "on_grading_failure": "fallback_deterministic_then_shadow",
    "on_winner_apply_failure": "fallback_primary_then_fail",
    "all_lanes_failed": "fallback_primary"
  }
}
```

## Validation

`/ab validate` reports configuration warnings/errors, including:
- unsupported `execution_strategy`
- missing required fields (`target_tool`, `trigger.tool`, lanes)
- mismatched `trigger.tool` vs `target_tool`
- `when_path_regex` caveat for proxy strategies

Invalid experiments are skipped at runtime.

## Grading behavior

- Grading runs in a separate `pi` process (`--no-extensions --no-skills ...`)
- Grader output must be strict JSON and lane scores must be in `[0,1]`
- One stricter retry is attempted on malformed grader output
- Optional transcript enrichment via `grading.include.tool_calls: true`

## Debug controls

Config:
- `"debug": true|false`
- `"debug_ui": "none" | "cmux"` (default `none`)

Env:

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
- `pi-extension/ab/selection.ts` — deterministic ranking formula evaluation
- `pi-extension/ab/winner.ts` — winner selection mode logic
- `pi-extension/ab/grading.ts` — grader process orchestration
- `pi-extension/ab/wizard.ts` — setup wizard
- `pi-extension/ab/gc.ts` — retention and cleanup

## Local checks

```bash
npm run typecheck
npm test
```
