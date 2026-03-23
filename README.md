# pi-ab-wip

A work-in-progress **pi extension** for A/B/C experimentation of tool+prompt behavior behind a transparent tool interception layer.

## Current status

Implemented prototype:

- `edit` override that transparently intercepts when trigger policy matches (`execution_strategy: "fixed_args"`)
- Generic non-edit interception:
  - `execution_strategy: "fixed_args"` → transparent override with identical args across lanes
  - `execution_strategy: "lane_single_call"` → proxy flow with exactly one target-tool call per lane
  - `execution_strategy: "lane_multi_call"` → proxy flow with lane-specific multi-step replanning (`{ task, context?, constraints? }`)
  - `target_tool`/`trigger.tool` are real gates
- Global/project experiment loading with project-overrides-global precedence
- Setup wizard (`/ab wizard` and `ab_setup_wizard` tool)
- Lane execution in isolated git worktrees (sandbox for lane side effects)
  - `execution_strategy: "fixed_args"` (transparent same-args lane execution)
  - `execution_strategy: "lane_single_call"` (proxy flow; one target-tool call per lane)
  - `execution_strategy: "lane_multi_call"` (proxy flow; lane-specific multi-step replanning)
  - default `lane_harness: "direct"` for fixed_args
  - `lane_harness: "pi_prompt"` for lane_single_call / lane_multi_call
- Winner selection modes:
  - `shadow`
  - `deterministic`
  - `grading` (separate grader `pi` process)
  - `hybrid`
    - `llm_tiebreaker` (LLM breaks deterministic ties)
    - `llm_score` (injects `{llm_score}` + `{deterministic_score}` into template scoring)
- Winner patch apply back to main workspace (`git apply` + `--3way` fallback)
- Run artifacts under `~/.pi/agent/ab/runs/...`

Still rough / next hardening:

- Richer grading confidence handling/aggregation policy
- Additional deterministic selection metrics and confidence reporting
- Optional retention policies (auto-gc schedules)

`debug: true` enables debug execution. By default (`debug_ui: "none"`) lanes/grader run headless in the background. Set `debug_ui: "cmux"` to open panes when running inside cmux.

Debug UI controls:
- `"debug_ui": "none"` (default) -> headless/background lane+grader execution (no panes)
- `"debug_ui": "cmux"` -> visible panes (for `lane_harness: "pi_prompt"`)
- env override: `PI_AB_DEBUG_UI=none|cmux`

Other debug env flags:
- `PI_AB_KEEP_PANES=1` keep panes open after completion
- `PI_AB_DEBUG_JSON=1` stream JSON event output in panes (off by default for readability)
- `PI_AB_LANE_HARNESS=direct|pi_prompt` override lane harness per run

Execution strategy notes:
- `execution_strategy: "fixed_args"` → conductor forwards one canonical call shape to all lanes.
  - Run manifest telemetry includes schema fairness as `capability_policy: "intersection" | "best_effort"` plus key sets.
- `execution_strategy: "lane_single_call"` → proxy flow where each lane calls the target tool exactly once (lane-specific schema allowed).
- `execution_strategy: "lane_multi_call"` → generic meta-tool flow where lanes can receive their own API and replan via `pi_prompt` lane sessions.
  - Main-lane proxy schema: `{ task, context?, constraints? }`.
- Grading input can optionally include per-lane tool-call transcripts (`grading.include.tool_calls: true`).
- Hybrid llm_score supports template formulas via:
  - `selection.hybrid.final_objective` (e.g. `max({deterministic_score} * 0.6 + {llm_score} * 0.4)`)
  - `selection.hybrid.final_tie_breakers`

## Files

- `pi-extension/ab/index.ts` — extension entrypoint, command/tool registrations, orchestration
- `pi-extension/ab/winner.ts` — winner selection + fallback logic (shadow/deterministic/grading)
- `pi-extension/ab/gc.ts` — `/ab gc` parsing and retention execution
- `pi-extension/ab/wizard.ts` — interactive setup wizard
- `pi-extension/ab/config.ts` — experiment discovery + trigger selection
- `pi-extension/ab/runner.ts` — worktree lane execution + patch apply helpers
- `pi-extension/ab/grading.ts` — separate grader process orchestration
- `pi-extension/ab/selection.ts` — deterministic lane selection
- `pi-extension/ab/storage.ts` — run artifact paths and writes
- `pi-extension/ab/types.ts` — config and run types

Project sample config:

- `.pi/ab/experiments/edit-lanes-v1.json`
- `.pi/ab/prompts/grade-default.md`

Controllable fixture:

- `fixtures/ab-test/target.txt`
- `fixtures/ab-test/lanes/edit-perm-{a,b,c}.ts`

## Install / run locally

```bash
# npm install is optional now (no runtime deps required)
pi -e ./pi-extension/ab/index.ts
```

Then in pi:

```text
/ab wizard
/ab status
/ab gc --keep-last 10         # dry-run
/ab gc --keep-last 10 --force # delete
```

## Controllable test use case

Prompt:

```text
Replace TOKEN=OLD with TOKEN=NEW in fixtures/ab-test/target.txt
```

Expected:

1. Tool call is intercepted by conductor (if trigger matches).
2. Lanes A/B/C run in isolated worktrees.
3. Winner is selected (deterministic by default in sample config).
4. Winner patch is applied to main workspace.
5. Run artifacts are written under:
   - `~/.pi/agent/ab/runs/pi-ab-wip/<run-id>/`
