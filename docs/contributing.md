# Contributing / development

## Repo areas

Core files:
- `pi-extension/lab/index.ts` — interception wiring, tool registration, `/lab` command
- `pi-extension/lab/config.ts` — experiment loading, validation, matching, path resolution
- `pi-extension/lab/runner.ts` — lane execution and worktree handling
- `pi-extension/lab/storage.ts` — run manifests, lane records, aggregate logging
- `pi-extension/lab/selection.ts` — formula scoring and ranking
- `pi-extension/lab/winner.ts` — winner selection logic
- `pi-extension/lab/grading.ts` — LLM grader orchestration
- `pi-extension/lab/gc.ts` — cleanup logic
- `pi-extension/lab/types.ts` — runtime types

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
