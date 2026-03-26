![pi-lab banner](./docs/assets/banner.png)

# pi-lab

`pi-lab` lets you run multiple **extension-backed lanes** behind a single tool call, compare them in isolation, and continue with one selected result.

> [!CAUTION]
> `pi-lab` is still an **experimental alpha**. Config shape, telemetry shape, and runtime behavior may still change before `v1`.

> [!NOTE]
> If `pi-lab` is useful to you, I'd be grateful for feedback, code, docs help, or sponsoring via:
>
> [![GitHub Sponsors](https://img.shields.io/badge/GitHub-Sponsors-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/marckrenn)
> [![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?logo=buymeacoffee&logoColor=000000)](https://buymeacoffee.com/marckrenn)

## Use it when you want to

- compare permutations of a tool or extension
- try alternative extension-backed lane bundles with different prompts, tools, or behavior
- let a formula, an LLM, or both choose which lane to proceed with
- keep a safe fallback lane while still collecting telemetry from alternatives

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
pi -e ./pi-extension/lab/index.ts
```

## Set up your first experiment

The easiest path is:
1. install `pi-lab`
2. open your project in pi
3. run `/lab create`
4. let pi-lab collect the setup details and inject them into the conversation

What the clanker should usually do:
- inspect the target tool or workflow before choosing `fixed_args`, `lane_single_call`, or `lane_multi_call`
- if the target is a builtin tool, ask whether you want a transparent same-name replacement (for example `edit`) or an explicit lab-only proxy tool name (for example `edit_experiment`)
- when you want normal agent requests to naturally use the replacement, keep the replacement under the builtin name instead of teaching the agent a differently named proxy
- create a project-local experiment directory at `.pi/lab/experiments/<experiment-id>/` with `experiment.json`, plus sibling `lanes/`, `tools/`, and `runs/` as needed
- create or wire lane files, prompts, tool helpers, and any companion extension needed for builtin-tool replacement, prompt guidance, or guardrails
- keep one lane as the baseline/fallback lane
- tell you how to run and inspect the experiment

If you want examples after that:
- [Config examples](docs/config-examples.md)
- [Strategies](docs/strategies.md)

## Builtin tool replacement pattern

When the compared tool is a builtin like `edit`, `write`, or `bash`, there are two different goals:

1. **Explicit lab proxy**
   - give the experiment a separate tool name such as `edit_experiment`
   - use this only when you want users and agents to call the lab flow explicitly
2. **Transparent replacement**
   - keep the replacement under the builtin name such as `edit`
   - use this when you want normal requests like “edit this file” to naturally hit the replacement

For transparent replacement, `pi-lab` config should usually be paired with a companion custom extension:
- use `deactivate_builtin_tools` in the experiment config when the builtin should disappear from the main session's active tool list
- also add a custom extension that blocks or redirects the builtin behavior as needed, explains that the builtin is not directly available, points the agent to the replacement under the same name, and adds any guardrails you want
- if you expose a differently named proxy tool instead of `edit`, most agents will not treat it as the default editor unless you add very strong extra guidance

`deactivate_builtin_tools` only manages the active tool list for the pi-lab-managed main session. It does **not** by itself add repo-specific prompt guidance, discoverability, or fallback blocking such as “use `edit`, not `write`, for existing files”.

## Git requirement

Normal multi-lane execution uses **git worktrees**.

That means:
- inside a git repo, lanes run in isolation
- outside a git repo, `pi-lab` falls back to the baseline lane only
- fallback reasons are written to telemetry so the behavior is visible

## `/lab`

`/lab` is the built-in control surface for pi-lab.

- `/lab` opens the interactive menu
- `/lab create` injects an experiment-setup kickoff into the normal conversation
- the menu has **Experiments**, **Runs**, and **Maintenance**
- text commands like `/lab experiments`, `/lab runs`, `/lab status`, `/lab validate`, and `/lab gc ...` also work

More details:
- [Troubleshooting and operations](docs/troubleshooting.md)

## Where config lives

Experiment configs are defined as JSON.

Canonical locations:
- **project-local**: `.pi/lab/experiments/<experiment-id>/experiment.json`
- **global**: `~/.pi/agent/lab/experiments/<experiment-id>/experiment.json`

Compatibility locations still loaded:
- **project-local flat files**: `.pi/lab/experiments/*.json`
- **legacy project-local flat files**: `.pi/ab/experiments/*.json`
- **global flat files**: `~/.pi/agent/lab/experiments/*.json`

If the same experiment id exists in multiple places, project-local config wins.

## Where runs and artifacts live

`pi-lab` now supports both local and global run storage.

### Local project data
- per-experiment run directories: `.pi/lab/experiments/<experiment-id>/runs/<run-id>/`
- per-experiment aggregate log: `.pi/lab/experiments/<experiment-id>/runs.jsonl`
- top-level aggregate log across all local experiments: `.pi/lab/runs.jsonl`
- legacy top-level run directories at `.pi/lab/<run-id>/` are still read for compatibility

### Global data
- per-experiment run directories: `~/.pi/agent/lab/<project>/experiments/<experiment-id>/runs/<run-id>/`
- per-experiment aggregate log: `~/.pi/agent/lab/<project>/experiments/<experiment-id>/runs.jsonl`
- top-level aggregate log across all project runs: `~/.pi/agent/lab/<project>/runs.jsonl`
- legacy top-level run directories at `~/.pi/agent/lab/<project>/<run-id>/` are still read for compatibility

More details:
- [Telemetry layout](docs/telemetry.md)

## Read more

- [Architecture](docs/architecture.md)
- [Strategies](docs/strategies.md)
- [Config examples](docs/config-examples.md)
- [Telemetry](docs/telemetry.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing / development](docs/contributing.md)
