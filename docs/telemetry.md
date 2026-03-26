# pi-lab telemetry and file layout

`pi-lab` writes both per-run artifacts and an aggregate project log.

## Run storage locations

### Local project data
- per-experiment run directory: `.pi/lab/experiments/<experiment-id>/runs/<run-id>/`
- per-experiment aggregate log: `.pi/lab/experiments/<experiment-id>/runs.jsonl`
- top-level aggregate log across all local experiments: `.pi/lab/runs.jsonl`
- legacy top-level run directories at `.pi/lab/<run-id>/` are still readable for compatibility

### Global data
- per-experiment run directory: `~/.pi/agent/lab/<project>/experiments/<experiment-id>/runs/<run-id>/`
- per-experiment aggregate log: `~/.pi/agent/lab/<project>/experiments/<experiment-id>/runs.jsonl`
- top-level aggregate log across all project runs: `~/.pi/agent/lab/<project>/runs.jsonl`
- legacy top-level run directories at `~/.pi/agent/lab/<project>/<run-id>/` are still readable for compatibility

## Common run files

Inside a run directory you will commonly see:
- `run.json`
- `lanes/<lane-id>.json`
- `artifacts/grading-input.json`
- `artifacts/grading-output.json`
- `artifacts/grading-raw-output-*.md`
- lane-specific artifacts written by the run

Empty `worktrees/` and `sessions/` scaffolding is pruned automatically when unused.

## `run.json`

Useful top-level fields include:

| Field | Meaning |
|---|---|
| `configured_winner_mode` | Winner mode configured in experiment JSON |
| `winner_mode` | Winner mode actually used for the run |
| `winner_lane_id` | Lane that won |
| `selection_source` | Where the decision came from |
| `fallback_reason_code` | Why a fallback happened |
| `execution_strategy` | Strategy used for the run |
| `stage` | Current/final stage of the run |
| `error` | Top-level error if the run failed |
| `reason` | Human-readable explanation for fallback/error paths |

## Lane records

Each lane record in `lanes/<lane-id>.json` includes lane-level status and metrics such as:
- success/error status
- latency
- token counts when available
- tool call counts (`tool_call_count`, plus strategy-specific variants like `target_tool_call_count` / `custom_tool_call_count`)
- harness information for `fixed_args`
- fallback reason details when direct harness execution fell back

Useful harness fields:
- `lane_harness_requested`
- `lane_harness_used`
- `lane_harness_fallback_reason`

## `runs.jsonl`

The aggregate log is append-only and records:
- run manifest events
- lane record events

This makes it easier to inspect a project's recent history without opening every run directory manually.
