import { describe, expect, test } from "bun:test";
import { selectWinner } from "../pi-extension/lab/winner.ts";

describe("winner selection", () => {
  test("hardcoded mode always selects configured hardcoded lane", async () => {
    const loaded: any = {
      source: "project",
      path: "/tmp/x.json",
      experiment: {
        id: "exp",
        enabled: true,
        tool: { name: "edit" },
        trigger: {},
        execution: { strategy: "fixed_args" },
        winner: { mode: "hardcoded", hardcoded_lane: "B" },
        lanes: [
          { id: "A", label: "A", baseline: true, extensions: [] },
          { id: "B", label: "B", baseline: false, extensions: [] },
        ],
      },
    };

    const records: any[] = [
      { lane_id: "A", status: "success", patch_path: "/tmp/a.patch", patch_bytes: 120 },
      { lane_id: "B", status: "error", error: "failed" },
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

    expect(result.winner_lane_id).toBe("B");
    expect(result.mode_used).toBe("hardcoded");
    expect(result.selection_source).toBe("hardcoded_lane_forced");
  });
});
