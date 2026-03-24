# @marckrenn/pi-lab

pi A/B conductor extension for running multiple lane variants behind one tool name, comparing them safely, and returning one selected result.

> **Warning**
> This project is an **experimental alpha** and intentionally lightweight. It is **not production ready**.
> Schema and runtime behavior may still change before `v1`.
>
It is useful when you want to:
- compare permutations of a tool or extension
- try alternative lane extensions that carry different prompts, tools, or behavior
- let a formula, an LLM, or both choose which lane to proceed with
- keep a safe fallback lane while still collecting telemetry from alternatives

A useful mental model:

- this works at the **lane extension level** (`lane`)
- each lane activates one or more extension files
- those extensions can:
  - override or provide the tool
  - carry a different prompt
  - change tool-use behavior
  - do different planning in proxy modes

So this is closer to comparing **lane permutations at the extension/tool-behavior level** than just swapping one function body.

## When to use this

Use it when you need at least one of these:
- safe side-by-side comparison of lane permutations
- formula-based lane grading from measurable metrics
- LLM-based lane grading for semantic quality
- reproducible run artifacts for debugging and regression analysis

## When not to use this

This is probably overkill if:
- you only have one stable implementation
- you do not need per-lane telemetry or artifacts
- multi-lane latency/cost is unacceptable
- your workflow cannot be isolated safely in worktrees

## What it does

- [Stage 1: Intercept](#stage-1-intercept) - decides whether an incoming tool call should become an experiment run.
- [Stage 2: Fork lanes](#stage-2-fork-lanes) - creates isolated workspaces so each lane runs independently.
- [Stage 3: Execute strategy](#stage-3-execute-strategy) - runs lanes using the execution style that fits the tool/task shape.
- [Stage 4: Choose winner](#stage-4-choose-winner) - picks the winner using a hardcoded lane, a formula, an LLM, or a blend.
- [Stage 5: Apply result](#stage-5-apply-result) - merges the winning patch/output back when applicable.
- [Stage 6: Persist telemetry](#stage-6-persist-telemetry) - writes run, lane, LLM, and fallback artifacts for later inspection.

## Quick start

```bash
cd /Users/marckrenn/Documents/projects/pi-lab
pi -e ./pi-extension/ab/index.ts
```

Inside pi:

```text
/ab wizard                     # create a new experiment config interactively
/ab status                     # show loaded experiments and where they came from
/ab validate                   # show config errors/warnings before you run anything
/ab gc --keep-last 10          # dry-run: show which old run folders would be deleted
/ab gc --keep-last 10 --force  # actually delete old run folders, keeping the newest 10
```

## Flowchart

The extension follows a deterministic path from interception → lane isolation → execution strategy → winner selection → artifact persistence.

![pi-lab extension flowchart](docs/pi-lab-extension-flow.svg)

- [Open as markdown-friendly link](docs/pi-lab-extension-flow.svg)


## Install (git-first preview)

The current public-preview path is **git-first**.
Nothing has been released to npm yet.

### Install preview builds (git-first)

```bash
pi install git:github.com/marckrenn/pi-lab
```

> **Note**
> This is a **public preview alpha**.
> This package is intended for pi extension/runtime consumption (TypeScript entrypoints loaded by pi).
> It is not aimed at generic Node.js imports in plain JS runtimes without TS loader support.

### Release caveats (alpha)

This is a **public preview** with intentional caveats:

- APIs, config shapes, and artifact formats are still stabilizing and may change before v1.
- There is no enterprise-grade policy engine or remote governance for rollout controls.
- Multi-lane runs intentionally trade throughput and cost for experimental confidence.

### Security / access warning

> This package executes user-provided lane extensions locally (they are loaded and run in your process/workspace).
> Only install/point to repositories and lane sets you fully trust.

- Never run this in an environment that cannot tolerate arbitrary local extension execution.
- Keep run artifacts and `~/.pi/agent/ab` directories scoped to trusted users.
- If you publish experiments or lane code for others, review access controls and rotate tokens used by grader LLM calls.

## What `/ab gc` does

A/B runs accumulate under:

`~/.pi/agent/ab/runs/<project>/<run-id>/`

`/ab gc` is just garbage collection for those run artifacts.

- by default it works on the **current project**
- `--keep-last 10` protects the 10 newest runs and targets older ones
- without `--force`, it is a **dry run** and only shows what would be deleted
- with `--force`, it actually removes those old run folders
- you can also use `--older-than 7d`, `--project NAME`, or `--all-projects`

> **Tip**
> Start with the dry-run version first. It is the safe way to confirm which run folders would be deleted.

### Where config lives

Experiment config files live in:

- **project-local**: `.pi/ab/experiments/*.json`
- **global**: `~/.pi/agent/ab/experiments/*.json`

This extension is now **JSON-only** for experiment config.

> **Note**
> If the same experiment id exists in both places, the project-local config wins.

### Reusable runtime package model

`@marckrenn/pi-lab` is designed to be used as a shared runtime dependency.

In your experiment package, add your own experiment JSON and lane assets:

- `experiments/` → experiment configuration files
- `lanes/` → lane extension files and lane-local modules
- `prompts/` → optional grading prompts and lane prompts

The package root exposes two import shapes:
- `createAbExtension` (named export): factory that accepts `experimentDirs`/`baseDir`.
- default export: already-instantiated extension equivalent to `createAbExtension()`.

Then register the experiment set in your package entry extension:

```ts
// your-experiment-pkg/index.ts
import { createAbExtension } from "@marckrenn/pi-lab";

export default createAbExtension({
  experimentDirs: ["./experiments"],
});
```

If you need deterministic path resolution across unusual runtimes, set `baseDir` explicitly:

```ts
export default createAbExtension({
  baseDir: import.meta.url,
  experimentDirs: ["./experiments"],
});
```

```ts
// Equivalent "no-options" form using the package default export
import abExtension from "@marckrenn/pi-lab";

export default abExtension;
```

#### Example packaged experiment layout

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
    variant-a-system.md
```

Example experiment file from that package:

```json
{
  "id": "edit-fast",
  "enabled": true,
  "tool": { "name": "edit" },
  "execution": { "strategy": "fixed_args" },
  "winner": {
    "mode": "llm",
    "llm": {
      "prompt_file": "../prompts/grade-edit.md"
    }
  },
  "lanes": [
    {
      "label": "baseline",
      "baseline": true,
      "extensions": ["../lanes/edit/baseline.ts"]
    },
    {
      "label": "variant-a",
      "extensions": ["../lanes/edit/variant-a.ts"]
    }
  ]
}
```

A lane in this package is an **ordered extension bundle**:
- `lanes[n].extensions` can include one or more extension modules.
- each module must default-export a function like `export default (pi) => { ... }`.
- all files needed by a lane should live in the same package and be read explicitly.
- files are loaded into an isolated worktree in array order.
- for `fixed_args`, each lane must expose the target tool directly (for `edit`, the default edit tool is injected automatically).

`fixed_args` is treated as an **input/protocol strategy** and is optimized with a direct harness when safe:
- for `lane_single_call` / `lane_multi_call`, runtime uses prompt-based `pi` subprocess execution.
- for `fixed_args`, runtime tries `direct` first and falls back to `pi_prompt` when direct execution fails.
- you can force prompt mode with `PI_AB_LANE_HARNESS=pi_prompt`.

When direct execution falls back (for any failure reason), the lane record includes:
- `lane_harness_requested`
- `lane_harness_used`
- `lane_harness_fallback_reason`

Relative lane/config paths are resolved first against the current project cwd (if present), then against the experiment file path.

> **Warning**
> Lane prompts should be plain files in your bundle (for example `prompts/lane-a.md`).
> Keep prompt behavior explicit in config and keep package prompt templates separate from lane runtime.

## Authoring vs runtime guarantees

### Authoring guarantees

- every experiment must define `tool.name`, `winner.mode`, and at least one lane.
- if no lane is marked as `baseline`, the runtime marks the first lane as baseline.
- each `extensions` entry should point to an extension module that default-exports `function (pi)`.
- lane paths are loaded from local file paths, so bundled lane and prompt assets must be present in your package.

### Runtime guarantees

- a matching experiment config is selected by `tool.name`, strategy, and trigger gates.
- all selected lanes are run and produce per-lane telemetry in `~/.pi/agent/ab/runs/...`.
- only one winner lane is selected and applied (or fallback policy is applied).
- `fixed_args` prefers direct lane execution for speed; if it fails or is overridden, runtime falls back to prompt-based execution.
- fallback decisions are explicit in telemetry: `run.json` includes `winner_mode`, `selection_source`, and `fallback_reason_code`; lane records include `lane_harness_requested`, `lane_harness_used`, and `lane_harness_fallback_reason`.

### Non-guarantees

- this project intentionally does not promise cross-run telemetry aggregation, cloud dashboards, or remote policy rollout controls.
- grading quality, semantic correctness, and model-level policy are controlled by your prompt/config, not by the harness.

### Wizard flow

`/ab wizard` asks in user-facing order:
1. scope + experiment id
2. target tool
3. execution strategy
4. trigger gates
5. timeout
6. how the winner should be chosen
7. LLM options (only when needed)
8. lane paths + baseline lane + hardcoded winner lane (if needed)

---

## Stage 1: Intercept

An experiment is eligible when:
- the called tool name matches `tool.name`
- optional trigger gates pass

### Trigger gates

| Field | Meaning |
|---|---|
| `sample_rate` | Probability gate (0..1) for whether the experiment should run |
| `when_path_regex` | Optional path filter, mainly useful when intercepted args include `path` |
| `when_oldtext_min_chars` | Optional minimum `oldText` size gate for edit-like flows |
| `cooldown_ms` | Minimum delay between runs of the same experiment |

If you omit `trigger`, the experiment is eligible for every call to `tool.name`.

## Stage 2: Fork lanes

Each lane runs in an isolated git worktree.

That gives you:
- no cross-lane file contamination
- safer experimentation with write/edit tools
- reproducible per-lane artifacts

## Stage 3: Execute strategy

### Which strategy should I use?

| If your situation is... | All lanes share same arguments? | Use |
|---|:---:|---|
| All lanes expose the same tool shape and accept the same args | ✅ | `fixed_args` |
| Lanes should each make exactly one target-tool call | ❌ | `lane_single_call` |
| Lanes may need lane-specific replanning or tool chaining | ❌ | `lane_multi_call` |

### Strategy details

| Strategy | Lane input | Protocol | Use case |
|---|---|---|---|
| `fixed_args` | Same intercepted args for all lanes | Direct tool call preferred; prompt fallback when direct is not safe/possible | Best when the experiment is a clean apples-to-apples comparison |
| `lane_single_call` | `{ task, context?, constraints? }` | Exactly one target-tool call + `LANE_DONE` | Best when each lane may shape the call differently, but must stay one-call-only |
| `lane_multi_call` | `{ task, context?, constraints? }` | Multi-step lane flow + strict final JSON | Best when lane extensions need their own planning or tool chaining |

> **Tip**
> If you are unsure, start with `fixed_args`. It is the simplest model and usually the easiest one to debug.

## Stage 4: Choose winner

### What "winner" means

In plain words:
1. **Grade** each lane result (by formula, LLM, or both).
2. **Proceed with** one lane result (the one called the `winner` in config/runtime).

So `winner` is just the lane whose output/patch is actually applied.

If you prefer different language, you can read it as:
- `winner` ≈ **proceed_with lane**
- `formula` / `llm` / `blend` ≈ **grading strategy**

> **Note**
> In other words: several lanes may run, but only one lane is the one the system actually proceeds with.

### Who decides the winner?

| `winner.mode` | Who decides? | Inputs used | Typical use |
|---|---|---|---|
| `hardcoded` | Explicit configured lane | None | Safe rollout where one lane must always win |
| `formula` | Formula | Metrics like `latency_ms`, `success`, `total_tokens`, `error`, `timeout` | Cheap, fast, deterministic winner selection |
| `llm` | LLM judge | Lane outputs + optional tool-call context | Semantic quality selection |
| `blend` | Formula + LLM judge | Metrics + LLM scores | Balance objective metrics and semantic quality |

### Winner modes

#### `hardcoded`
A configured lane always wins.

Use this when you want observability from other lanes, but mergeback must always come from one specific lane.

#### `formula`
The winner is chosen from `winner.formula.objective` and optional `tie_breakers`.

Typical metrics include:
- `latency_ms`
- `success`
- `total_tokens`
- `error`
- `timeout`

Use this when measurable metrics are enough and you want a cheap, fast, deterministic grading step.

#### `llm`
The winner is chosen by the LLM judge.

Use this when semantic correctness or output quality matters more than raw metrics.

#### `blend`
Formula ranking provides the baseline, and the LLM is used either:
- only to break formula ties (`llm_tiebreaker`), or
- as an additional score (`llm_score`)

Use this when you want both objective metrics and semantic judgment.

### Baseline lane vs hardcoded winner lane

These are different concepts:

- **baseline lane**: safe fallback lane used when the chosen winner cannot be used or all lanes fail
- **hardcoded winner lane**: the lane that always wins when `winner.mode = "hardcoded"`

### LLM failure policy

LLM judging can fail because of:
- timeout
- non-zero grader exit
- invalid JSON output
- invalid output schema
- no usable winner

When that happens, `failure_policy.on_llm_failure` controls what happens next:
- `fallback_formula_then_baseline`
- `fallback_baseline`

## Stage 5: Apply result

For patch-producing tools like `edit`, the selected lane result is applied back to the main workspace.

Apply flow:
1. try normal patch apply
2. if needed, try `--3way` fallback
3. if configured, fall back to the baseline lane on winner-apply failure

## Stage 6: Persist telemetry

Artifacts are written to:

`~/.pi/agent/ab/runs/<project>/<run-id>/`

Common files:
- `run.json`
- `lanes/{id}.json`
- `artifacts/grading-input.json`
- `artifacts/grading-output.json`
- `artifacts/grading-raw-output-*.md`
- `lanes/<id>/target-before.md`
- `lanes/<id>/target-after.md`
- `sessions/...` (prompt harness runs)

---

## Config examples

### Smallest valid config

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
- omitting `trigger` means "eligible for every call to `tool.name`"
- omitting `execution` defaults to `fixed_args`
- omitting `winner.formula.objective` defaults to `min(latency_ms)`
- if no lane is marked `baseline`, the first lane becomes baseline automatically

> **Tip**
> The smallest config is intentionally tiny. You can start there and add trigger rules, failure policy, and LLM grading only when you actually need them.


### Hardcoded winner

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
    { "label": "baseline", "baseline": true, "extensions": ["./lanes/a.ts"] },
    { "label": "experiment", "extensions": ["./lanes/b.ts"] }
  ]
}
```

### Formula winner

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
    { "label": "baseline", "baseline": true, "extensions": ["./lanes/a.ts"] },
    { "label": "faster", "extensions": ["./lanes/b.ts"] }
  ]
}
```

### LLM winner

```jsonc
{
  "id": "best-semantic-result",
  "enabled": true,
  "tool": { "name": "edit" },
  "execution": { "strategy": "fixed_args" },
  "winner": {
    "mode": "llm",
    "llm": {
      "prompt_file": "./.pi/ab/prompts/grade-default.md",
      "include_tool_calls": true
    }
  },
  "lanes": [
    { "label": "baseline", "baseline": true, "extensions": ["./lanes/a.ts"] },
    { "label": "safer", "extensions": ["./lanes/b.ts"] }
  ]
}
```

### Blend winner

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
      "prompt_file": "./.pi/ab/prompts/grade-default.md"
    },
    "blend": {
      "mode": "llm_score",
      "formula_weight": 0.7,
      "llm_weight": 0.3
    }
  },
  "lanes": [
    { "label": "baseline", "baseline": true, "extensions": ["./lanes/a.ts"] },
    { "label": "better", "extensions": ["./lanes/b.ts"] }
  ]
}
```

### Inline LLM prompt

```jsonc
{
  "winner": {
    "mode": "llm",
    "llm": {
      "prompt": "Prefer correctness first, then safety, then efficiency."
    }
  }
}
```

### Grouped-by-intent example

```jsonc
{
  "id": "edit-lanes-v1",
  "enabled": true,

  "tool": {
    "name": "edit"
  },

  "trigger": {
    "sample_rate": 1,
    "when_path_regex": "^fixtures/ab-test/",
    "when_oldtext_min_chars": 1,
    "cooldown_ms": 0
  },

  "execution": {
    "strategy": "fixed_args",
    "timeout_ms": 15000
  },

  "winner": {
    "mode": "formula",
    "formula": {
      "objective": "min({latency_ms} + {error} * 100000 + {timeout} * 100000)",
      "tie_breakers": ["max(success)", "min(total_tokens)"]
    }
  },

  "lanes": [
    { "label": "A", "extensions": ["./fixtures/ab-test/lanes/edit-perm-a.ts"] },
    { "label": "B", "baseline": true, "extensions": ["./fixtures/ab-test/lanes/edit-perm-b.ts"] },
    { "label": "C", "extensions": ["./fixtures/ab-test/lanes/edit-perm-c.ts"] }
  ],

  "failure_policy": {
    "on_lane_timeout": "exclude_continue",
    "on_lane_crash": "exclude_continue",
    "on_llm_failure": "fallback_formula_then_baseline",
    "on_winner_apply_failure": "fallback_baseline_then_fail",
    "all_lanes_failed": "fallback_baseline"
  },

  "debug": {
    "enabled": false,
    "ui": "none"
  }
}
```

## Recommended defaults

If you are starting from scratch:
- start with `execution.strategy: "fixed_args"`
- start with `winner.mode: "formula"`
- keep one clear baseline lane
- use `sample_rate: 1` while developing
- turn on `winner.mode: "llm"` only when semantic quality really matters
- use `winner.mode: "blend"` only after formula metrics are already useful

## Key `run.json` fields

| Field | Why it matters |
|---|---|
| `configured_winner_mode` | What the experiment was configured to use |
| `winner_mode` | What actually determined the winner (including fallbacks) |
| `winner_lane_id` | Which lane won |
| `selection_source` | Where the decision came from |
| `fallback_reason_code` | Why a fallback happened |
| `llm_error_code` | Why LLM judging failed, if it failed |
| `execution_strategy` | Which runtime lane protocol was used |
| `lane_harness` | Which harness was selected for this experiment run |

Lane records in `lanes/{id}.json` include additional fallback visibility fields:
- `lane_harness_requested`
- `lane_harness_used`
- `lane_harness_fallback_reason`

## First 5 things to inspect when a run behaves weirdly

1. `run.json` - winner decision, fallback, and top-level path
2. `lanes/{id}.json` - per-lane status, latency, protocol errors, patch info
3. `artifacts/grading-output.json` - what the LLM judge returned
4. `artifacts/grading-raw-output-*.md` - raw grader stdout/stderr when LLM judging failed
5. `sessions/...` - lane transcripts for prompt-based strategies

## Validation

`/ab validate` reports configuration warnings/errors.

Examples:
- unsupported `execution.strategy`
- missing `tool.name` or `winner.mode`
- invalid `winner.hardcoded_lane`
- `trigger.when_path_regex` caveat for proxy strategies
- invalid combinations like both `winner.llm.prompt` and `winner.llm.prompt_file`

Invalid experiments are skipped at runtime.

## Debug controls

Config:
- `debug.enabled`
- `debug.ui: "none" | "cmux"`

Env overrides:

```bash
PI_AB_DEBUG_UI=cmux
PI_AB_KEEP_PANES=1
PI_AB_DEBUG_JSON=1
```

## Future work / missing pieces

This project is intentionally early-stage. Important missing pieces include:

- **Telemetry backend**: upload run summaries/artifacts to a central server (not implemented yet).
- **Hosted dashboard**: compare experiments across machines/repos over time.
- **Safer rollout controls**: policy presets, guardrails, and better blast-radius limits.
- **Richer eval workflows**: better batch grading, regression suites, and trend analysis.
- **Schema stability pass**: lock naming after a few more real-world iterations.

> **Note**
> The telemetry-upload piece is intentionally listed here as future work. Today, artifacts stay local on disk.

If you want to contribute ideas, open an issue/PR with:
- your use case,
- what broke or felt confusing,
- and what signal you needed but couldn't get.

## Project files

- `pi-extension/ab/index.ts` - interception wiring and command registration
- `pi-extension/ab/config.ts` - experiment loading, normalization, validation, matching
- `pi-extension/ab/runner.ts` - lane execution/worktree handling
- `pi-extension/ab/selection.ts` - formula scoring/ranking
- `pi-extension/ab/winner.ts` - winner logic
- `pi-extension/ab/grading.ts` - LLM judge process orchestration
- `pi-extension/ab/wizard.ts` - setup wizard
- `pi-extension/ab/gc.ts` - retention and cleanup

## Local checks

```bash
npm run typecheck
npm test
```
