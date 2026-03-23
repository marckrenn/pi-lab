# pi-ab-wip

Work-in-progress **pi A/B conductor extension** for transparent tool interception, lane isolation, winner selection, and telemetry.

## What it supports today

- Transparent interception by `target_tool` + `trigger` policy
- Three execution strategies:
  - `fixed_args`
  - `lane_single_call`
  - `lane_multi_call`
- Four winner modes:
  - `shadow`
  - `deterministic`
  - `grading`
  - `hybrid` (`llm_tiebreaker`, `llm_score`)
- Lane execution in isolated git worktrees
- Winner patch application back to main workspace (`git apply`, then `--3way` fallback)
- Grading in a separate `pi` process
- Run artifacts under `~/.pi/agent/ab/runs/<project>/<run-id>/`

## Quick start

```bash
cd /Users/marckrenn/Documents/projects/pi-ab-wip
pi -e ./pi-extension/ab/index.ts
```

Inside pi:

```text
/ab wizard
/ab status
/ab validate
/ab gc --keep-last 10         # dry-run
/ab gc --keep-last 10 --force # delete
```

## Core concepts

### Execution strategy

| Strategy | What lanes receive | Typical harness | Protocol |
|---|---|---|---|
| `fixed_args` | Same intercepted args for all lanes | `direct` | Lane calls intercepted tool directly |
| `lane_single_call` | `{ task, context?, constraints? }` wrapper | `pi_prompt` | Exactly one target-tool call + `LANE_DONE` |
| `lane_multi_call` | `{ task, context?, constraints? }` wrapper | `pi_prompt` | Multi-step lane flow with strict final JSON |

### Winner mode

| Mode | Behavior |
|---|---|
| `shadow` | Keep primary lane output |
| `deterministic` | Formula/tie-break based ranking |
| `grading` | External grader picks winner; fallback policy on failure |
| `hybrid` | Deterministic + LLM (`llm_tiebreaker` or `llm_score`) |

## Hybrid template scoring (new)

For `mode: "hybrid"` + `selection.hybrid.mode: "llm_score"`, the final ranking can use template formulas directly.

Injected metrics per lane:
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
- `artifacts/grading-raw-output-*.txt`
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
- `pi-extension/ab/winner.ts` — shadow/deterministic/grading/hybrid selection
- `pi-extension/ab/grading.ts` — grader process orchestration
- `pi-extension/ab/wizard.ts` — setup wizard
- `pi-extension/ab/gc.ts` — run retention/cleanup

## Local checks

```bash
npm run typecheck
npm test
```
