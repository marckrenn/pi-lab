# pi-lab config examples

Experiment configs are JSON-only.

Locations:
- project-local: `.pi/lab/experiments/*.json`
- global: `~/.pi/agent/lab/experiments/*.json`

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

## Lane model override

```jsonc
{
  "id": "planner-lab",
  "tool": { "name": "planner" },
  "execution": { "strategy": "lane_multi_call" },
  "winner": { "mode": "formula" },
  "lanes": [
    { "id": "baseline", "baseline": true, "extensions": ["./lanes/a.ts"] },
    { "id": "fast", "model": "openai/gpt-5-mini", "extensions": ["./lanes/b.ts"] },
    { "id": "deep", "model": "anthropic/claude-sonnet-4-6", "extensions": ["./lanes/c.ts"] }
  ]
}
```

If `model` is omitted, `lane_single_call` and `lane_multi_call` inherit the main session model.

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
