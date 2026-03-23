# pi-ab-wip

Work-in-progress **pi A/B conductor extension** for running multiple lane variants behind one tool name, comparing them safely, and returning one chosen result to the user.

Use it when you want to:
- compare multiple tool implementations behind the same interface
- benchmark prompt or extension variants safely in isolated worktrees
- let metrics, an LLM grader, or both decide which lane should win
- keep a safe primary lane while still collecting telemetry from alternatives

## When to use this

Use this extension when you need at least one of these:
- **safe comparison** of multiple lane implementations
- **deterministic winner selection** from measurable metrics
- **LLM-based winner selection** for semantic quality
- **full run artifacts** for debugging, benchmarking, and regression analysis

## When not to use this

This is probably overkill if:
- you only have one stable implementation
- you do not need per-lane telemetry or artifacts
- the latency/cost of running multiple lanes is unacceptable
- your workflow has side effects that cannot be isolated well in worktrees

## What it does

- [Stage 1: Intercept](#stage-1-intercept) — decides whether an incoming tool call should turn into an experiment run.
- [Stage 2: Fork lanes](#stage-2-fork-lanes) — creates isolated lane workspaces so each candidate runs independently.
- [Stage 3: Execute strategy](#stage-3-execute-strategy) — runs lanes using the strategy that matches your tool shape and task style.
- [Stage 4: Score and select winner](#stage-4-score-and-select-winner) — chooses which lane counts, using metrics, LLM grading, or a combination.
- [Stage 5: Apply result](#stage-5-apply-result) — merges the winner back into the main workspace when the tool produces a patch/output.
- [Stage 6: Persist telemetry](#stage-6-persist-telemetry) — writes run, lane, grading, and fallback artifacts for inspection later.

## Quick start

```bash
cd /Users/marckrenn/Documents/projects/pi-ab-wip
pi -e ./pi-extension/ab/index.ts
```

Inside pi:

```text
/ab wizard                     # create a new experiment config interactively
/ab status                     # show loaded experiments and where they came from
/ab validate                   # show config warnings/errors before you run anything
/ab gc --keep-last 10          # preview which old runs would be removed
/ab gc --keep-last 10 --force  # actually delete the matching old runs
```

### Wizard flow

`/ab wizard` now asks in user-facing order:
1. scope + experiment id
2. target tool
3. execution strategy
4. trigger gates
5. timeout
6. winner mode
7. grading options (only when needed)
8. lane paths + primary lane

---

## Stage 1: Intercept

The extension watches for calls to `target_tool`.

An experiment matches when:
- the called tool name equals `target_tool`
- optional trigger gates pass

### Trigger gates

| Field | Meaning |
|---|---|
| `sample_rate` | Probability gate (0..1) for whether the experiment should run |
| `when_path_regex` | Optional path filter, mainly useful when the intercepted args include `path` |
| `when_oldtext_min_chars` | Optional minimum `oldText` length gate for edit-like flows |
| `cooldown_ms` | Minimum delay between runs of the same experiment |

If no valid experiment matches, the tool call proceeds normally.

## Stage 2: Fork lanes

Each lane runs in an isolated git worktree.

That gives you:
- no cross-lane file contamination
- safer experimentation with write/edit tools
- reproducible per-lane artifacts

## Stage 3: Execute strategy

### Which strategy should I use?

| If your situation is... | Use |
|---|---|
| All lanes expose the same tool shape and can accept the same args | `fixed_args` |
| Lanes should each make exactly one target-tool call | `lane_single_call` |
| Lanes may need lane-specific replanning or tool chaining | `lane_multi_call` |

### Strategy details

| Strategy | Lane input | Typical harness | Protocol | Use case |
|---|---|---|---|---|
| `fixed_args` | Same intercepted args for all lanes | `direct` | Lane calls intercepted tool directly | Apples-to-apples implementation comparison |
| `lane_single_call` | `{ task, context?, constraints? }` | `pi_prompt` | Exactly one target-tool call + `LANE_DONE` | One-call discipline with lane-specific argument schemas |
| `lane_multi_call` | `{ task, context?, constraints? }` | `pi_prompt` | Multi-step lane flow + strict final JSON | Lane-level replanning/tool chaining |

### One example per strategy

**`fixed_args`**
- User/tool call: `edit({ path, oldText, newText })`
- All lanes receive the same args.
- Best for comparing multiple implementations of the same tool contract.

**`lane_single_call`**
- User/tool call: `{ task, context?, constraints? }`
- Each lane must produce exactly one target-tool call.
- Best for strict one-step flows.

**`lane_multi_call`**
- User/tool call: `{ task, context?, constraints? }`
- Lanes may replan and use different internal APIs before returning final JSON.
- Best for more open-ended flows.

### What the system infers

The system infers lane harness from `execution_strategy`:
- `fixed_args` → `direct`
- `lane_single_call` / `lane_multi_call` → `pi_prompt`

Advanced override remains available via:

```bash
PI_AB_LANE_HARNESS=direct|pi_prompt
```

## Stage 4: Score and select winner

### Who decides the winner?

| `winner_mode` | Who decides? | Inputs used | Typical use |
|---|---|---|---|
| `shadow` | Primary lane config | None | Safe rollout where one lane must always merge back |
| `deterministic` | Formula engine | Metrics | Cheap, explainable selection |
| `grading` | LLM grader | Lane outputs + optional transcripts/artifacts | Semantic quality selection |
| `hybrid` | Formula engine + LLM grader | Metrics + LLM scores | Balance speed/cost and semantic quality |

### Winner selection modes

#### `shadow`
- The **primary lane always wins** mergeback.
- Other lanes may still run and produce telemetry.
- Use this when you want observability without changing the applied result.

#### `deterministic`
- Winner is chosen from `selection.deterministic.objective` and `tie_breakers`.
- Use this when measurable metrics are enough.

#### `grading`
- Winner is chosen by the LLM grader.
- Use this when semantic correctness or output quality matters more than raw metrics.

#### `hybrid`
- Deterministic ranking provides the baseline.
- LLM grading is then used either:
  - only to break deterministic ties (`llm_tiebreaker`), or
  - as an additional score (`llm_score`)

### Why `selection.deterministic` and `selection.hybrid` are separate

They control different layers of winner selection:
- `selection.deterministic` defines the baseline ranking model
- `selection.hybrid` defines how LLM grading is added on top of that baseline

This lets one deterministic model serve three roles:
- standalone deterministic winner selection
- fallback ranking when grading fails
- baseline ranking for hybrid selection

### Grading fallback policy

Grading can fail because of:
- timeout
- non-zero grader exit
- invalid JSON output
- invalid output schema
- grader choosing no usable winner

When that happens, `failure_policy.on_grading_failure` controls what happens next:
- `fallback_deterministic_then_shadow`
- `fallback_shadow`

## Stage 5: Apply result

For patch-producing tools like `edit`, the selected lane result is applied back to the main workspace.

Apply flow:
1. try normal patch apply
2. if needed, try `--3way` fallback
3. if configured, fall back to primary apply behavior on winner-apply failure

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

## Config mental model

Think of the config in five blocks:

1. **Identity** — what this experiment is called and which tool it intercepts
2. **Trigger** — when the experiment should run
3. **Execution** — how lanes are executed
4. **Winner selection** — how the winner is decided
5. **Operations** — lanes, failure policy, grading, debug

## You configure vs the system infers

### You configure
- `target_tool`
- `trigger` gates
- `execution_strategy`
- `winner_mode`
- `lanes`
- optional `selection`, `grading`, `failure_policy`, `debug_ui`

### The system infers
- lane harness from strategy
- whether path-gating is applicable
- which artifacts are created based on execution path

---

## Config examples

### Minimal valid config

```json
{
  "id": "example",
  "enabled": true,
  "target_tool": "edit",
  "trigger": {},
  "execution_strategy": "fixed_args",
  "winner_mode": "deterministic",
  "lanes": [
    { "id": "A", "primary": true, "extensions": ["./a.ts"] },
    { "id": "B", "extensions": ["./b.ts"] }
  ]
}
```

### Deterministic example

```jsonc
{
  "id": "edit-deterministic",
  "enabled": true,
  "target_tool": "edit",
  "trigger": {
    "sample_rate": 1,
    "when_path_regex": "^fixtures/ab-test/"
  },
  "execution_strategy": "fixed_args",
  "timeout_ms": 15000,
  "winner_mode": "deterministic",
  "selection": {
    "deterministic": {
      "objective": "min({latency_ms} + {error} * 100000 + {timeout} * 100000)",
      "tie_breakers": ["max(success)", "min(total_tokens)"]
    }
  },
  "lanes": [
    { "id": "A", "primary": true, "extensions": ["./fixtures/ab-test/lanes/edit-perm-a.ts"] },
    { "id": "B", "extensions": ["./fixtures/ab-test/lanes/edit-perm-b.ts"] },
    { "id": "C", "extensions": ["./fixtures/ab-test/lanes/edit-perm-c.ts"] }
  ]
}
```

### Grading example (LLM-only winner selection)

```jsonc
{
  "id": "edit-grading",
  "enabled": true,
  "target_tool": "edit",
  "trigger": { "sample_rate": 1 },
  "execution_strategy": "fixed_args",
  "winner_mode": "grading",
  "grading": {
    "execution": "process",
    "timeout_ms": 12000,
    "prompt_file": "./.pi/ab/prompts/grade-default.md",
    "include": { "tool_calls": true }
  },
  "lanes": [
    { "id": "A", "primary": true, "extensions": ["./a.ts"] },
    { "id": "B", "extensions": ["./b.ts"] }
  ]
}
```

### Hybrid example

```jsonc
{
  "id": "edit-hybrid",
  "enabled": true,
  "target_tool": "edit",
  "trigger": { "sample_rate": 1 },
  "execution_strategy": "fixed_args",
  "winner_mode": "hybrid",
  "selection": {
    "deterministic": {
      "objective": "min({latency_ms} + {error} * 100000 + {timeout} * 100000)",
      "tie_breakers": ["max(success)"]
    },
    "hybrid": {
      "mode": "llm_score",
      "deterministic_weight": 0.7,
      "llm_weight": 0.3,
      "final_objective": "max({deterministic_score} * 0.7 + {llm_score} * 0.3)",
      "final_tie_breakers": ["max(llm_score)"]
    }
  },
  "grading": {
    "execution": "process",
    "prompt_file": "./.pi/ab/prompts/grade-default.md"
  },
  "lanes": [
    { "id": "A", "primary": true, "extensions": ["./a.ts"] },
    { "id": "B", "extensions": ["./b.ts"] }
  ]
}
```

### Shadow example

```jsonc
{
  "id": "edit-shadow",
  "enabled": true,
  "target_tool": "edit",
  "trigger": { "sample_rate": 1 },
  "execution_strategy": "fixed_args",
  "winner_mode": "shadow",
  "lanes": [
    { "id": "A", "primary": true, "extensions": ["./a.ts"] },
    { "id": "B", "extensions": ["./b.ts"] },
    { "id": "C", "extensions": ["./c.ts"] }
  ]
}
```

### Grouped-by-intent annotated JSONC

```jsonc
{
  // Identity
  "id": "edit-lanes-v1",
  "enabled": true,
  "target_tool": "edit",

  // Trigger gates
  "trigger": {
    "sample_rate": 1,
    "when_path_regex": "^fixtures/ab-test/",
    "when_oldtext_min_chars": 1,
    "cooldown_ms": 0
  },

  // Execution
  "execution_strategy": "fixed_args",
  "timeout_ms": 15000,

  // Winner selection
  "winner_mode": "deterministic",
  "selection": {
    "deterministic": {
      "objective": "min({latency_ms} + {error} * 100000 + {timeout} * 100000)",
      "tie_breakers": ["max(success)", "min(total_tokens)"]
    },
    "hybrid": {
      "mode": "llm_score",
      "deterministic_weight": 0.7,
      "llm_weight": 0.3,
      "final_objective": "max({deterministic_score} * 0.7 + {llm_score} * 0.3)",
      "final_tie_breakers": ["max(llm_score)"]
    }
  },

  // Grading
  "grading": {
    "execution": "process",
    "timeout_ms": 12000,
    "prompt_file": "./.pi/ab/prompts/grade-default.md",
    "include": { "tool_calls": true }
  },

  // Lanes
  "lanes": [
    { "id": "A", "primary": false, "extensions": ["./fixtures/ab-test/lanes/edit-perm-a.ts"] },
    { "id": "B", "primary": true,  "extensions": ["./fixtures/ab-test/lanes/edit-perm-b.ts"] },
    { "id": "C", "primary": false, "extensions": ["./fixtures/ab-test/lanes/edit-perm-c.ts"] }
  ],

  // Failure policy
  "failure_policy": {
    "on_lane_timeout": "exclude_continue",
    "on_lane_crash": "exclude_continue",
    "on_grading_failure": "fallback_deterministic_then_shadow",
    "on_winner_apply_failure": "fallback_primary_then_fail",
    "all_lanes_failed": "fallback_primary"
  },

  // Debug
  "debug": false,
  "debug_ui": "none"
}
```

## Recommended defaults

If you are starting from scratch:
- start with `execution_strategy: "fixed_args"`
- start with `winner_mode: "deterministic"`
- keep one clear primary lane
- use `sample_rate: 1` while developing
- turn on `grading` only when semantic quality really matters
- use `hybrid` only after deterministic metrics are already meaningful

## Key `run.json` fields

| Field | Why it matters |
|---|---|
| `configured_winner_mode` | What the experiment was configured to use |
| `winner_mode` | What actually determined the winner (including fallbacks) |
| `winner_lane_id` | Which lane won |
| `selection_source` | Where the decision came from |
| `fallback_reason_code` | Why a fallback happened |
| `grading_error_code` | Why grading failed, if it failed |
| `execution_strategy` | Which runtime lane protocol was used |
| `lane_harness` | Which harness actually ran |

## First 5 things to inspect when a run behaves weirdly

1. `run.json` — winner, fallback, and top-level decision path
2. `lanes/{id}.json` — per-lane status, latency, protocol errors, patch info
3. `artifacts/grading-output.json` — what the grader actually returned
4. `artifacts/grading-raw-output-*.md` — raw grader stdout/stderr when grading failed
5. `sessions/...` — lane transcripts for prompt-based strategies

## Validation

`/ab validate` reports configuration warnings/errors.

Examples:
- unsupported `execution_strategy`
- missing `target_tool` or `winner_mode`
- legacy keys such as `trigger.tool`, `mode`, or `lane_harness`
- `when_path_regex` caveat for proxy strategies

Invalid experiments are skipped at runtime.

## Debug controls

Config:
- `"debug": true|false`
- `"debug_ui": "none" | "cmux"`

Env overrides:

```bash
PI_AB_DEBUG_UI=cmux
PI_AB_KEEP_PANES=1
PI_AB_DEBUG_JSON=1
PI_AB_LANE_HARNESS=direct|pi_prompt
```

## Project files

- `pi-extension/ab/index.ts` — interception wiring and command registration
- `pi-extension/ab/config.ts` — experiment loading, validation, matching
- `pi-extension/ab/runner.ts` — lane execution/worktree handling
- `pi-extension/ab/selection.ts` — deterministic scoring/ranking
- `pi-extension/ab/winner.ts` — winner mode logic
- `pi-extension/ab/grading.ts` — grader process orchestration
- `pi-extension/ab/wizard.ts` — setup wizard
- `pi-extension/ab/gc.ts` — retention and cleanup

## Local checks

```bash
npm run typecheck
npm test
```
