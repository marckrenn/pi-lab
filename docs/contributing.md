# Contributing / development

## Repo areas

Core files:
- `pi-extension/ab/index.ts` — interception wiring, tool registration, `/lab` command
- `pi-extension/ab/config.ts` — experiment loading, validation, matching, path resolution
- `pi-extension/ab/runner.ts` — lane execution and worktree handling
- `pi-extension/ab/storage.ts` — run manifests, lane records, aggregate logging
- `pi-extension/ab/selection.ts` — formula scoring and ranking
- `pi-extension/ab/winner.ts` — winner selection logic
- `pi-extension/ab/grading.ts` — LLM grader orchestration
- `pi-extension/ab/gc.ts` — cleanup logic
- `pi-extension/ab/types.ts` — runtime types

## Local checks

```bash
bun run typecheck
bun test ./tests
```

## Notes

- keep README user-focused; move deep internals into `docs/`
- prefer `.pi/lab/experiments/` for project-local experiments
- keep `.pi/ab/experiments/` compatibility intact unless intentionally removing legacy support
- when updating `/lab`, keep both interactive and text command paths in sync
