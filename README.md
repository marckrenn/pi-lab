# pi-ab-wip

A work-in-progress **pi extension** for A/B/C experimentation of tool+prompt behavior behind a transparent tool interception layer.

## Current status

Implemented prototype:

- `edit` override that transparently intercepts when trigger policy matches
- Global/project experiment loading with project-overrides-global precedence
- Setup wizard (`/ab wizard` and `ab_setup_wizard` tool)
- Lane execution in isolated git worktrees
  - default `lane_harness: "direct"` (non-LLM direct tool execution)
  - optional `lane_harness: "pi_prompt"` (legacy prompt-driven subprocess lanes)
- Winner selection modes:
  - `shadow`
  - `deterministic`
  - `grading` (separate grader `pi` process)
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

## Files

- `pi-extension/ab/index.ts` — extension entrypoint, command/tool registrations, orchestration
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
