# pi-lab troubleshooting and operations

## First places to inspect when a run behaves strangely

1. `run.json`
   - winner decision
   - fallback reason
   - top-level stage and error
2. `lanes/<lane-id>.json`
   - per-lane status
   - protocol errors
   - latency and token metrics
3. `runs.jsonl`
   - aggregate manifest + lane events for the project
4. `artifacts/grading-output.json`
   - structured LLM judge output
5. `artifacts/grading-raw-output-*.md`
   - raw grader output when LLM judging fails

## `/lab` commands

Useful commands:

```text
/lab status
/lab validate
/lab runs
/lab maintenance
/lab gc --keep-last 10
/lab gc --keep-last 10 --force
/lab gc --older-than 7d
/lab gc --project my-project
/lab gc --all-projects
/lab gc --help
```

## Cleanup behavior

`/lab gc` removes old run artifacts.

By default:
- it works on the current project
- it keeps the newest 10 runs
- it is preview-only unless `--force` is set

Supported flags:
- `--keep-last N`
- `--older-than <number><s|m|h|d>`
- `--project NAME`
- `--all-projects`
- `--force`
- `--help`

## Validation

`/lab validate` reports experiment warnings and errors before you run anything.

Typical problems include:
- missing `tool.name`
- missing `winner.mode`
- invalid `winner.hardcoded_lane`
- unsupported `execution.strategy`
- invalid trigger regex
- conflicting LLM prompt options

Invalid experiments are skipped at runtime.

## Debug controls

Config:
- `debug.enabled`
- `debug.ui: "none" | "cmux"`

Environment overrides:

```bash
PI_LAB_DEBUG_UI=cmux
PI_LAB_KEEP_PANES=1
PI_LAB_DEBUG_JSON=1
```
