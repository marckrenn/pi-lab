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
/lab create
/lab status
/lab validate
/lab runs
/lab maintenance
/lab tools
/lab tools builtins
/lab tools refresh
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

## `/lab tools`

`/lab tools` is the runtime control surface for the current session.

Useful cases:
- inspect whether a builtin name is active or disabled in the session
- inspect whether a same-name pi-lab interceptor is visible
- toggle builtin tool availability on/off per session
- switch supported builtins between `lab` routing and `native` routing

Current labels mean:
- `enabled (default)` / `disabled (default)` — matches pi's default builtin tool set
- `enabled (session override)` / `disabled (session override)` — changed in this session
- `pi default` — no pi-lab routing toggle is active for that builtin
- `lab (...)` — prefer the pi-lab interceptor when supported
- `native (...)` — force native bypass when supported

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

## Agent keeps choosing the wrong tool name

Common symptom:
- you expected the agent to use `edit`
- but it keeps reaching for `write` or a differently named proxy such as `edit_experiment`

Usually fix it like this:
1. if the tool should behave like a builtin replacement, keep the replacement under the builtin name (`edit`, not `edit_experiment`)
2. add `deactivate_builtin_tools` in the experiment config when the builtin should disappear from the main session's active tool list
3. add a companion custom extension that blocks or redirects the builtin behavior as needed, tells the agent the builtin is not directly available, and tells it to use the replacement under the same name
4. add guardrails in that extension if needed, for example blocking `write` on existing files

Important nuance:
- `deactivate_builtin_tools` updates the active tool list for the pi-lab-managed main session
- it does **not** by itself add prompt guidance or explain why the replacement should be preferred
- if you expose a separate proxy tool name, agents will usually treat it as a special-purpose tool rather than the default builtin replacement
- for proxy-flow `edit` experiments, include an explicit `path` when the task targets a specific file, especially across repos
- this is a recommendation for file-targeted proxy `edit` flows, not a requirement that every pi-lab tool expose `path`
- if the resolved target path is not inside a git repo, pi-lab warns and falls back to the baseline lane only
