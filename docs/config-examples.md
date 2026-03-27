# pi-lab config examples

Experiment configs are JSON-only.

Canonical locations:
- project-local: `.pi/lab/experiments/<experiment-id>/experiment.json`
- global: `~/.pi/agent/lab/experiments/<experiment-id>/experiment.json`

Compatibility locations still loaded:
- project-local flat files: `.pi/lab/experiments/*.json`
- legacy project-local flat files: `.pi/ab/experiments/*.json`
- global flat files: `~/.pi/agent/lab/experiments/*.json`

Recommended project-local layout:

```text
.pi/lab/experiments/<experiment-id>/
  experiment.json
  lanes/
  tools/
  runs/
  runs.jsonl
```

Relative paths inside `experiment.json` are resolved from the directory containing that config file first, then fall back to the project cwd for compatibility.

## Smallest valid config

```json
{
  "id": "example",
  "enabled": true,
  "tool": { "name": "edit" },
  "winner": { "mode": "formula" },
  "lanes": [
    { "extensions": ["./a.ts"] },
    { "extensions": ["./b.ts"] }
  ]
}
```

Notes:
- omitting `trigger` means the experiment can match every call to `tool.name`
- omitting `execution` defaults to `fixed_args`
- if no lane is marked as `baseline`, the first lane becomes baseline automatically
- optional `deactivate_builtin_tools` removes builtins from the active tool list for the main session; if pi-lab also registers a tool with the same name, that lab tool stays active

## Deactivate builtins for a session

```jsonc
{
  "id": "intercept-edit-only",
  "enabled": true,
  "tool": { "name": "edit" },
  "deactivate_builtin_tools": ["edit"],
  "execution": { "strategy": "lane_multi_call" },
  "winner": { "mode": "formula" },
  "lanes": [
    { "id": "baseline", "baseline": true, "extensions": ["./lanes/edit/builtin.ts"] },
    { "id": "variant", "extensions": ["./lanes/edit/variant.ts"] }
  ]
}
```

This is useful when you want the main session to stop offering the builtin tool directly and route calls through a pi-lab interceptor instead.

Behavior notes:
- this field is optional
- it is applied in the main session at `session_start`
- values should be builtin tool names such as `read`, `bash`, `edit`, `write`, `grep`, `find`, or `ls`
- if pi-lab also registers a tool with the same name, that lab tool remains active after the builtin is deactivated
- this changes the active tool list, but by itself it does not add prompt guidance or explain to the agent why it should prefer the replacement
- for builtin replacement patterns you usually also want a companion custom extension that blocks or redirects the builtin behavior as needed, says the builtin is not directly available, and points the agent to the replacement under the same name

## Transparent builtin replacement pattern

If you want the agent to keep using the builtin name naturally, keep the replacement under that same builtin name.

For proxy-flow builtin replacement, the most reliable shape is:
- `task`
- optional `path`
- optional `context`
- optional `constraints`

For `edit`, include `path` whenever the flow targets a specific file. This is especially important for cross-repo edits because pi-lab can then root lane worktrees in the target file's git repo instead of relying on prompt-text path inference.

This does not mean every pi-lab tool now needs a `path` field. It is specifically the recommended shape for file-targeted proxy `edit` flows.

Example goal:
- user says “edit this file”
- agent should call `edit`
- `pi-lab` should intercept that `edit` call behind the scenes

Config side:

```jsonc
{
  "id": "transparent-edit-replacement",
  "enabled": true,
  "tool": {
    "name": "edit",
    "description": "Primary edit tool for this repo. The builtin edit tool is not directly available here."
  },
  "deactivate_builtin_tools": ["edit"],
  "execution": { "strategy": "lane_multi_call" },
  "winner": { "mode": "formula" },
  "lanes": [
    { "id": "baseline", "baseline": true, "extensions": ["./lanes/edit/builtin.ts"] },
    { "id": "variant", "extensions": ["./lanes/edit/variant.ts"] }
  ]
}
```

Companion extension side:
- add a custom project/package extension when you want strong discoverability and guardrails
- tell the agent that the builtin `edit` tool is not directly available, block or redirect the builtin path as needed, and tell it to use the repo's `edit` tool instead
- if needed, block undesired fallbacks such as using `write` to overwrite existing files
- if you expose a separate proxy name like `edit_experiment`, treat that as an explicit lab-only tool, not as the default replacement for `edit`

Rule of thumb:
- if you want natural builtin-like usage, register the replacement as `edit`
- if you want an explicit benchmark/proxy flow, use a distinct name such as `edit_experiment`

Example proxy-flow edit call shape:

```jsonc
{
  "task": "Make a few harmless dummy edits to this file.",
  "path": "/Users/me/project/playground/basic.txt",
  "context": "Plain-text playground file with placeholder content.",
  "constraints": "Only modify that file. Keep the changes small and obviously dummy/test-oriented."
}
```

## Hardcoded winner

```jsonc
{
  "id": "safe-rollout",
  "enabled": true,
  "tool": { "name": "edit" },
  "execution": { "strategy": "fixed_args" },
  "winner": {
    "mode": "hardcoded",
    "hardcoded_lane": "baseline"
  },
  "lanes": [
    { "id": "baseline", "baseline": true, "extensions": ["./lanes/a.ts"] },
    { "id": "experiment", "extensions": ["./lanes/b.ts"] }
  ]
}
```

## Formula winner

```jsonc
{
  "id": "fastest-edit",
  "enabled": true,
  "tool": { "name": "edit" },
  "execution": { "strategy": "fixed_args", "timeout_ms": 15000 },
  "winner": {
    "mode": "formula",
    "formula": {
      "objective": "min(latency_ms)",
      "tie_breakers": ["max(success)"]
    }
  },
  "lanes": [
    { "id": "baseline", "baseline": true, "extensions": ["./lanes/a.ts"] },
    { "id": "faster", "extensions": ["./lanes/b.ts"] }
  ]
}
```

## Lane model / thinking override

```jsonc
{
  "id": "planner-lab",
  "tool": { "name": "planner" },
  "execution": { "strategy": "lane_multi_call" },
  "winner": { "mode": "formula" },
  "lanes": [
    { "id": "baseline", "baseline": true, "extensions": ["./lanes/a.ts"] },
    { "id": "fast", "model": "openai/gpt-5-mini", "thinking": "low", "extensions": ["./lanes/b.ts"] },
    { "id": "deep", "model": "anthropic/claude-sonnet-4-6", "thinking": "high", "extensions": ["./lanes/c.ts"] }
  ]
}
```

If `model` is omitted, `lane_single_call` and `lane_multi_call` inherit the main session model.

If `thinking` is omitted, `lane_single_call` and `lane_multi_call` inherit the main session thinking level. Valid values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.

## LLM winner

```jsonc
{
  "id": "best-semantic-result",
  "enabled": true,
  "tool": { "name": "edit" },
  "execution": { "strategy": "fixed_args" },
  "winner": {
    "mode": "llm",
    "llm": {
      "prompt_file": "./prompts/grade-edit.md",
      "include_tool_calls": true
    }
  },
  "lanes": [
    { "id": "baseline", "baseline": true, "extensions": ["./lanes/a.ts"] },
    { "id": "safer", "extensions": ["./lanes/b.ts"] }
  ]
}
```

## Blend winner

```jsonc
{
  "id": "fast-and-good",
  "enabled": true,
  "tool": { "name": "edit" },
  "execution": { "strategy": "fixed_args" },
  "winner": {
    "mode": "blend",
    "formula": {
      "objective": "min(latency_ms)",
      "tie_breakers": ["max(success)"]
    },
    "llm": {
      "prompt_file": "./prompts/grade-edit.md"
    },
    "blend": {
      "mode": "llm_score",
      "formula_weight": 0.1,
      "llm_weight": 0.9
    }
  },
  "lanes": [
    { "id": "baseline", "baseline": true, "extensions": ["./lanes/a.ts"] },
    { "id": "better", "extensions": ["./lanes/b.ts"] }
  ]
}
```

## Recommended defaults

If you are starting from scratch:
- keep one clear baseline lane
- start with `winner.mode: "formula"`
- use `sample_rate: 1` while developing
- use `fixed_args` only when every lane really accepts the same arguments
- add LLM judging only when semantic quality matters

## Package-style experiment layout

A reusable experiment package usually looks like this:

```text
my-experiment-pack/
  package.json
  index.ts
  experiments/
    edit-fast.json
  lanes/
    edit/
      baseline.ts
      variant-a.ts
  prompts/
    grade-edit.md
```

Example package entrypoint:

```ts
import { createLabExtension } from "@marckrenn/pi-lab";

export default createLabExtension({
  experimentDirs: ["./experiments"],
});
```

If needed, you can also set `baseDir` explicitly for path resolution.
