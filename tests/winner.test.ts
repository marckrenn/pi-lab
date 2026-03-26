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

  test("formula mode exposes per-lane scores for all lanes", async () => {
    const loaded: any = {
      source: "project",
      path: "/tmp/x.json",
      experiment: {
        id: "exp",
        enabled: true,
        tool: { name: "edit" },
        trigger: {},
        execution: { strategy: "fixed_args" },
        winner: {
          mode: "formula",
          formula: {
            objective: "min(latency_ms)",
            tie_breakers: ["max(success)"],
          },
        },
        lanes: [
          { id: "baseline", label: "baseline", baseline: true, extensions: [] },
          { id: "fast", label: "fast", baseline: false, extensions: [] },
          { id: "broken", label: "broken", baseline: false, extensions: [] },
        ],
      },
    };

    const records: any[] = [
      { lane_id: "baseline", status: "success", latency_ms: 20, patch_path: "/tmp/a.patch", patch_bytes: 120 },
      { lane_id: "fast", status: "success", latency_ms: 10, patch_path: "/tmp/b.patch", patch_bytes: 80 },
      { lane_id: "broken", status: "error", error: "failed" },
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

    expect(result.winner_lane_id).toBe("fast");
    expect(result.selection_source).toBe("formula");
    expect(result.scores).toEqual([
      { lane_id: "baseline", score: 0, reason: "min(latency_ms) with tie-breakers" },
      { lane_id: "fast", score: 1, reason: "min(latency_ms) with tie-breakers" },
      { lane_id: "broken", score: 0 },
    ]);
  });
});
