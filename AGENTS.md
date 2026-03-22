# AGENTS Guidance

- Spawn subagents aggressively to parallelize tasks whenever work can be split safely.
- Some subagents have specialized tools and workflows that make them faster/better for specific domains than the main agent.
- Before choosing workers, list available subagents with the `subagents_list` tool and route work to the best-fit agent(s).
- Prefer parallel subagents for independent tracks; use sequential execution only when tasks share files or strict ordering.
