import { describe, expect, test } from "bun:test";
import { selectWinner } from "../pi-extension/ab/winner.ts";

describe("winner selection", () => {
  test("shadow mode always selects primary lane", async () => {
    const loaded: any = {
      source: "project",
      path: "/tmp/x.json",
      experiment: {
        id: "exp",
        enabled: true,
        target_tool: "edit",
        trigger: {},
        winner_mode: "shadow",
        execution_strategy: "fixed_args",
        lanes: [
          { id: "A", primary: true, extensions: [] },
          { id: "B", primary: false, extensions: [] },
        ],
      },
    };

    const records: any[] = [
      { lane_id: "A", status: "error", error: "failed" },
      { lane_id: "B", status: "success", patch_path: "/tmp/p.patch", patch_bytes: 123 },
    ];

    const result = await selectWinner(
      loaded,
      { runId: "r", dir: "/tmp/r" },
      process.cwd(),
      records,
      { intercepted_tool: "edit", intercepted_args: {} },
      undefined,
      undefined,
    );

    expect(result.winner_lane_id).toBe("A");
    expect(result.mode_used).toBe("shadow");
    expect(result.selection_source).toBe("shadow_primary_forced");
  });
});
