![pi-lab banner](./docs/assets/banner.png)

# @marckrenn/pi-lab

> Draft replacement for `README.md`.
> Goal: keep the top-level README focused on onboarding, and move deep reference material into `docs/`.

`pi-lab` lets you run multiple **extension-backed lanes** behind a single tool call, compare them in isolation, and continue with one selected result.

> **Warning**
> `pi-lab` is still an **experimental alpha**. Config shape, telemetry shape, and runtime behavior may still change before `v1`.

> **Note**
> If `pi-lab` is useful to you, I'd be grateful for feedback, code, docs help, or GitHub Sponsors: <https://github.com/sponsors/marckrenn>

## When to use it

Use `pi-lab` when you want to:
- compare different lane bundles for the same task
- keep a safe baseline while testing alternative prompts/tools/behavior
- choose a result with a formula, an LLM judge, or a blend of both
- inspect run artifacts after the fact

## When not to use it

`pi-lab` is probably overkill if:
- you only have one stable implementation
- per-lane latency/cost is unacceptable
- you do not need lane telemetry or reproducible run artifacts
- your workflow cannot be isolated safely in git worktrees

## What it does

A typical run looks like this:
1. intercept a matching tool call
2. fork isolated lane workspaces
3. execute lanes with the configured strategy
4. choose a winner
5. apply the selected result
6. persist telemetry and artifacts

![pi-lab extension flowchart](docs/pi-lab-extension-flow.svg)

- [Open the flowchart directly](docs/pi-lab-extension-flow.svg)
- [Architecture details](docs/architecture.md)
- [Execution strategies](docs/strategies.md)

## Install

The current install path is **git-first preview**.

```bash
pi install git:github.com/marckrenn/pi-lab
```

For local repo development:

```bash
cd /path/to/pi-lab
pi -e ./pi-extension/ab/index.ts
```

## Git requirement

Normal multi-lane execution uses **git worktrees**.

That means:
- inside a git repo, lanes run in isolation
- outside a git repo, `pi-lab` falls back to the baseline lane only
- fallback reasons are written to telemetry so the behavior is visible

## `/lab` command overview

`/lab` works both interactively and via text subcommands.

### Interactive mode

Run:

```text
/lab
```

Main menu:
- **Experiments** — list and toggle experiments
- **Runs** — inspect recent local/global runs for the current project
- **Maintenance** — preview or delete old runs

### Text subcommands

| Command | What it does |
|---|---|
| `/lab` | Open the interactive menu |
| `/lab experiments` | List experiments |
| `/lab experiments toggle <id>` | Toggle one experiment |
| `/lab experiments on <id>` | Enable one experiment |
| `/lab experiments off <id>` | Disable one experiment |
| `/lab runs` | Open the runs inspector |
| `/lab maintenance` | Open the maintenance menu |
| `/lab status` | Show loaded experiments and where they came from |
| `/lab validate` | Show config warnings/errors |
| `/lab gc --keep-last 10` | Preview cleanup |
| `/lab gc --keep-last 10 --force` | Delete old runs |

More on cleanup flags and debugging:
- [Troubleshooting and operations](docs/troubleshooting.md)

## Where config lives

Experiment configs are JSON-only.

Locations:
- **project-local**: `.pi/lab/experiments/*.json`
- **project-local legacy compat**: `.pi/ab/experiments/*.json`
- **global**: `~/.pi/agent/lab/experiments/*.json`

If the same experiment id exists in multiple places, project-local config wins.

## Where runs and artifacts live

`pi-lab` now supports both local and global run storage.

### Local project data
- run directories: `.pi/lab/<run-id>/`
- aggregate log: `.pi/lab/runs.jsonl`

### Global data
- run directories: `~/.pi/agent/lab/<project>/<run-id>/`
- aggregate log: `~/.pi/agent/lab/<project>/runs.jsonl`

More details:
- [Telemetry layout](docs/telemetry.md)

## Minimal config example

```json
{
  "id": "example-edit-experiment",
  "enabled": true,
  "tool": { "name": "edit" },
  "execution": { "strategy": "fixed_args" },
  "winner": {
    "mode": "formula",
    "formula": {
      "objective": "min(latency_ms)",
      "tie_breakers": ["max(success)"]
    }
  },
  "lanes": [
    {
      "id": "baseline",
      "baseline": true,
      "extensions": ["./lanes/edit/baseline.ts"]
    },
    {
      "id": "variant-a",
      "extensions": ["./lanes/edit/variant-a.ts"]
    }
  ]
}
```

Notes:
- if you omit `execution.strategy`, it defaults to `fixed_args`
- if you omit `trigger`, the experiment can match every call to `tool.name`
- if no lane is marked as baseline, the first lane becomes the baseline automatically

More examples:
- [Config examples](docs/config-examples.md)

## Safety note

`pi-lab` executes user-provided lane extensions locally.

Only install or run experiments you trust.

That means:
- do not use untrusted lane code
- treat lane prompts, lane extensions, and grader prompts as executable inputs to your workflow
- keep `~/.pi/agent/lab` and project `.pi/lab` data scoped to trusted users

## Read more

- [Architecture](docs/architecture.md)
- [Strategies](docs/strategies.md)
- [Config examples](docs/config-examples.md)
- [Telemetry](docs/telemetry.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing / development](docs/contributing.md)
