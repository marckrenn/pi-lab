# pi-lab architecture

`pi-lab` runs multiple lane bundles behind one intercepted tool call, compares them, and proceeds with one selected result.

This page documents the high-level runtime flow.

## The 6 stages

1. **Intercept**
   - match a tool call by `tool.name`
   - apply optional trigger gates

2. **Fork lanes**
   - create isolated git worktrees when the current project is inside a git repo
   - if not in a git repo, fall back to the baseline lane only for supported flows

3. **Execute strategy**
   - run lanes using one of:
     - `fixed_args`
     - `lane_single_call`
     - `lane_multi_call`
   - for `fixed_args`, `pi-lab` prefers a direct lane harness when safe and can fall back to prompt-based execution

4. **Choose winner**
   - use `hardcoded`, `formula`, `llm`, or `blend`
   - selection metadata is written to `run.json`

5. **Apply result**
   - for patch-producing tools like `edit`, apply the selected output back to the main workspace
   - if normal patch application fails, `pi-lab` can try a fallback path such as three-way apply and, depending on policy, baseline fallback

6. **Persist telemetry**
   - write `run.json`
   - write per-lane records in `lanes/*.json`
   - write grader artifacts when LLM grading is used
   - append aggregate events to `runs.jsonl`

## Trigger gates

Common trigger gates:

| Field | Meaning |
|---|---|
| `sample_rate` | Probability gate from `0..1` |
| `when_path_regex` | Optional path filter |
| `when_oldtext_min_chars` | Optional minimum `oldText` length gate |
| `cooldown_ms` | Minimum delay between runs of the same experiment |

If `trigger` is omitted, the experiment can match every call to `tool.name`.

## Baseline lane vs winner lane

These are different concepts.

- **baseline lane**: the safe fallback lane
- **winner lane**: the lane whose result is actually applied for this run

If `winner.mode` is `hardcoded`, the configured hardcoded lane always wins, but the baseline lane still matters for fallbacks.

## Fallbacks worth knowing about

### Non-git fallback
If the current project is not a git repo, `pi-lab` cannot safely create isolated worktrees for normal multi-lane execution.

In that case it falls back to the baseline lane only and records that fallback in telemetry.

### Direct harness fallback
For `fixed_args`, `pi-lab` tries a direct lane harness first when it can.

If that direct path is unsupported or fails, the lane can fall back to prompt-based execution. The lane record shows the requested harness, the harness actually used, and the fallback reason.

### Apply fallback
For patch-producing tools, `pi-lab` can attempt a fallback apply path if the initial winner patch application fails.

## Related docs

- [Strategies](./strategies.md)
- [Config examples](./config-examples.md)
- [Telemetry](./telemetry.md)
- [Troubleshooting](./troubleshooting.md)
