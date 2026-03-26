# pi-lab execution strategies

Choose the strategy based on the shape of the thing you are comparing.

## Decision guide

Ask these questions in order:

1. **Do all lanes accept the exact same argument shape for the compared call?**
   - If yes, use `fixed_args`.
2. **Are you still comparing one intentional tool call, but lanes may shape it differently?**
   - If yes, use `lane_single_call`.
3. **Do lanes need lane-specific replanning or multiple tool steps?**
   - Then use `lane_multi_call`.

## Strategy table

| Strategy | Lane input | Runtime shape | Best for |
|---|---|---|---|
| `fixed_args` | Same intercepted args for every lane | Direct tool call preferred, prompt fallback if needed | Clean apples-to-apples comparisons |
| `lane_single_call` | `{ task, context?, constraints? }` | One intentional target-tool call | Comparing different ways to make one call |
| `lane_multi_call` | `{ task, context?, constraints? }` | Multi-step flow with replanning | Richer lane-specific workflows |

## `fixed_args`

Use `fixed_args` when every lane truly supports the same intercepted arguments.

Typical use:
- comparing several versions of `edit`
- replaying the same input into each lane
- optimizing for measurable metrics like latency or tokens

Notes:
- this is the default strategy if omitted
- `pi-lab` prefers a direct harness when possible
- if direct execution is unsupported or fails, it can fall back to prompt-based execution

## `lane_single_call`

Use `lane_single_call` when you are still comparing one intentional call, but each lane may need to shape that call differently.

Typical use:
- comparing tool wrappers that build slightly different arguments
- comparing prompt styles around one target call

## `lane_multi_call`

Use `lane_multi_call` when the comparison is broader than one call shape.

Typical use:
- compare lane-specific planning
- compare tool chains or multi-step flows
- compare more autonomous lane behavior

## Recommendation

If you are unsure:
- start by inspecting the target tool interface
- use `fixed_args` only when the argument shape is truly identical across lanes
- otherwise prefer `lane_single_call` or `lane_multi_call`

## Related docs

- [Architecture](./architecture.md)
- [Config examples](./config-examples.md)
