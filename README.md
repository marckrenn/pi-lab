# pi-ab-wip

Work-in-progress **pi A/B conductor extension** for transparent tool interception, lane isolation, winner selection, and telemetry.

## What it does (stage-by-stage)

- [Stage 1: Intercept](#stage-1-intercept) — match a real tool call against experiment trigger policy.
- [Stage 2: Fork lanes](#stage-2-fork-lanes) — run lane variants in isolated git worktrees.
- [Stage 3: Execute strategy](#stage-3-execute-strategy) — execute lane logic via `fixed_args`, `lane_single_call`, or `lane_multi_call`.
- [Stage 4: Score and select winner](#stage-4-score-and-select-winner) — choose winner using deterministic, LLM grading, or hybrid logic.
- [Stage 5: Apply result](#stage-5-apply-result) — apply winner patch/output back to the main workspace.
- [Stage 6: Persist telemetry](#stage-6-persist-telemetry) — write run/lane/grading/fallback artifacts.

## What it supports today

- Transparent interception by `target_tool` + `trigger` policy
- Three execution strategies: `fixed_args`, `lane_single_call`, `lane_multi_call`
- Four winner selection modes: `shadow`, `deterministic`, `grading`, `hybrid`
- Lane execution in isolated git worktrees
- Winner patch application (`git apply`, then `--3way` fallback)
- Grading in a separate `pi` process
- Config validation via `/ab validate`

## Quick start

```bash
cd /Users/marckrenn/Documents/projects/pi-ab-wip
pi -e ./pi-extension/ab/index.ts
```

Inside pi:

```text
/ab wizard                     # interactive setup; writes experiment + grading prompt scaffold
/ab status                     # list loaded experiments and where they were loaded from
/ab validate                   # show config warnings/errors (invalid experiments are skipped)
/ab gc --keep-last 10         # dry-run cleanup preview
/ab gc --keep-last 10 --force # actually delete matching runs
```

## Terminology (to keep naming consistent)

- **Winner selection mode**: high-level lane-selection policy (`shadow`, `deterministic`, `grading`, `hybrid`).
- **Scoring**: assigning numeric preference to lanes (formula score and/or LLM score).
- **Grading**: LLM-based scoring/ranking step in a separate grader process.
- **Winner selection**: final `winner_lane_id` decision after applying mode policy + fallbacks.

## Core concepts

### Stage 1: Intercept

The conductor matches real tool calls using:
- `target_tool`
- `trigger.tool`
- optional trigger gates:
  - `sample_rate`
  - `when_path_regex`
  - `when_oldtext_min_chars`
  - `cooldown_ms`

If no valid enabled experiment matches, the tool call proceeds normally.

**Where to get trigger-gate details:**
- Wizard: `/ab wizard` (recommended starting point)
- Runtime validation: `/ab validate`
- Source of truth:
  - `pi-extension/ab/types.ts` (schema/types)
  - `pi-extension/ab/config.ts` (`selectExperimentForTool` + `validateExperimentConfig`)

### Stage 2: Fork lanes

Each lane runs in an isolated git worktree so lane side effects do not pollute each other or the main workspace.

### Stage 3: Execute strategy

| Strategy | What lanes receive | Typical harness | Protocol | Use case |
|---|---|---|---|---|
| `fixed_args` | Same intercepted args for all lanes | `direct` | Lane calls intercepted tool directly | Fast apples-to-apples tool implementation comparison |
| `lane_single_call` | `{ task, context?, constraints? }` wrapper | `pi_prompt` | Exactly one target-tool call + `LANE_DONE` | Enforce one-call discipline while still allowing lane-specific schemas |
| `lane_multi_call` | `{ task, context?, constraints? }` wrapper | `pi_prompt` | Multi-step lane flow with strict final JSON | Let lanes replan/tool-chain for harder tasks |

### Stage 4: Score and select winner

| Winner selection mode | Behavior | Use case |
|---|---|---|
| `shadow` | Keep primary lane output | Safety-first rollout or passive benchmarking |
| `deterministic` | Formula/tie-break based ranking | Low-cost, explainable ranking from measurable metrics |
| `grading` | **LLM-only winner selection** by external grader (with fallback policy on grader failure) | Quality-first selection when semantic correctness matters most |
| `hybrid` | Deterministic + LLM (`llm_tiebreaker` or `llm_score`) | Blend objective metrics with semantic judgment |

Yes — if you want winner selection based solely on LLM grading, use:

```json
{ "mode": "grading" }
```

### Stage 5: Apply result

Winner patch/output is applied back to the main workspace (`git apply`, then `--3way` fallback when needed).

### Stage 6: Persist telemetry

Run/lane/grading/fallback artifacts are written under `~/.pi/agent/ab/runs/<project>/<run-id>/`.

## Hybrid template scoring

For `mode: "hybrid"` + `selection.hybrid.mode: "llm_score"`, final ranking uses template scoring with injected metrics:

- `{llm_score}` (0..1 from grader)
- `{deterministic_score}` (normalized deterministic rank)

Optional config:

```json
{
  "mode": "hybrid",
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

If `final_objective` is omitted, a default weighted formula is used.

## Annotated experiment config (JSONC)

```jsonc
{
  "id": "edit-lanes-v1",                     // unique experiment id
  "enabled": true,
  "target_tool": "edit",                     // actual intercepted tool name
  "trigger": {
    "tool": "edit",                          // should usually match target_tool
    "sample_rate": 1,                          // 0..1 sampling gate
    "when_path_regex": "^fixtures/ab-test/", // optional path gate (mostly fixed_args)
    "when_oldtext_min_chars": 1,               // optional content-size gate (edit-like flows)
    "cooldown_ms": 0                           // optional per-experiment cooldown
  },

  "mode": "deterministic",                   // winner selection mode
  "execution_strategy": "fixed_args",        // fixed_args | lane_single_call | lane_multi_call

  "lanes": [
    { "id": "A", "primary": false, "extensions": ["./fixtures/ab-test/lanes/edit-perm-a.ts"] },
    { "id": "B", "primary": true,  "extensions": ["./fixtures/ab-test/lanes/edit-perm-b.ts"] },
    { "id": "C", "primary": false, "extensions": ["./fixtures/ab-test/lanes/edit-perm-c.ts"] }
  ],

  "timeout_ms": 15000,
  "lane_harness": "direct",                  // direct for fixed_args, pi_prompt for proxy flows

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

## Grading and transcripts

- Grading runs in a separate `pi` process (`--no-extensions --no-skills ...`)
- Grader output must be strict JSON and scores must be in `[0,1]`
- On malformed grader output, conductor performs one stricter retry
- Optional transcript enrichment:

```json
{
  "grading": {
    "include": {
      "tool_calls": true
    }
  }
}
```

When enabled, `artifacts/grading-input.json` includes `lane_tool_calls`.

## Validation behavior

`/ab validate` reports per-experiment warnings/errors, including:
- unsupported `execution_strategy`
- missing required fields (`target_tool`, `trigger.tool`, lanes)
- suspicious `trigger.tool != target_tool`
- `when_path_regex` warning for proxy strategies

Invalid experiments are skipped at runtime.

## Artifacts

Per-run directory:

- `run.json` (winner + selection source + fallback reason codes)
- `lanes/{id}.json` (lane status/metrics/errors)
- `artifacts/grading-input.json`
- `artifacts/grading-output.json`
- `artifacts/grading-raw-output-*.md`
- `lanes/<id>/target-before.md` + `lanes/<id>/target-after.md`
- `sessions/...` for prompt-based lane harness runs

## Debug controls

Config:
- `"debug": true|false`
- `"debug_ui": "none" | "cmux"` (default `none`)

Env overrides:

```bash
PI_AB_DEBUG_UI=cmux
PI_AB_KEEP_PANES=1
PI_AB_DEBUG_JSON=1
PI_AB_LANE_HARNESS=direct|pi_prompt
```

## Project files

- `pi-extension/ab/index.ts` — extension entrypoint/interception wiring
- `pi-extension/ab/config.ts` — config loading + validation + matching
- `pi-extension/ab/runner.ts` — lane execution/worktree handling
- `pi-extension/ab/selection.ts` — deterministic ranking/formula parsing
- `pi-extension/ab/winner.ts` — winner selection policy implementation
- `pi-extension/ab/grading.ts` — grader process orchestration
- `pi-extension/ab/wizard.ts` — setup wizard
- `pi-extension/ab/gc.ts` — run retention/cleanup

## Local checks

```bash
npm run typecheck
npm test
```
