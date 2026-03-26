import { describe, expect, test } from "bun:test";
import { normalizedScoresFromRanking, rankFormulaLanes } from "../pi-extension/lab/selection.ts";

const baseExperiment = {
  id: "e",
  tool: { name: "calculator" },
  trigger: {},
  execution: { strategy: "fixed_args" },
  winner: {
    mode: "formula",
    formula: {
      objective: "max(success)",
      tie_breakers: [],
    },
  },
  lanes: [
    { id: "A", label: "A", baseline: true, extensions: [] },
    { id: "B", label: "B", baseline: false, extensions: [] },
  ],
} as const;

describe("formula ranking comparator", () => {
  test("compareWithoutIdFallback returns tie while compare remains stable", () => {
    const lanes = [
      { lane_id: "A", status: "success" as const },
      { lane_id: "B", status: "success" as const },
    ];

    const ranking = rankFormulaLanes(baseExperiment as any, lanes as any);
    expect(ranking.compareWithoutIdFallback(lanes[0] as any, lanes[1] as any)).toBe(0);
    expect(ranking.compare(lanes[0] as any, lanes[1] as any)).toBeLessThan(0);
  });

  test("normalizedScoresFromRanking gives identical scores to tied lanes", () => {
    const lanes = [
      { lane_id: "A", status: "success" as const },
      { lane_id: "B", status: "success" as const },
      { lane_id: "C", status: "error" as const },
    ];

    const ranking = rankFormulaLanes(baseExperiment as any, lanes as any);
    const scores = normalizedScoresFromRanking(ranking);

    expect(scores).toEqual([
      { lane_id: "A", score: 1, reason: "max(success)" },
      { lane_id: "B", score: 1, reason: "max(success)" },
    ]);
  });

  test("formula can rank by tool call count", () => {
    const experiment = {
      ...baseExperiment,
      winner: {
        mode: "formula",
        formula: {
          objective: "min(tool_call_count)",
          tie_breakers: ["min(latency_ms)"],
        },
      },
    };

    const lanes = [
      { lane_id: "A", status: "success" as const, total_tool_call_count: 3, latency_ms: 10 },
      { lane_id: "B", status: "success" as const, total_tool_call_count: 1, latency_ms: 20 },
      { lane_id: "C", status: "success" as const, total_tool_call_count: 2, latency_ms: 5 },
    ];

    const ranking = rankFormulaLanes(experiment as any, lanes as any);

    expect(ranking.sorted.map((lane) => lane.lane_id)).toEqual(["B", "C", "A"]);
    expect(ranking.reason).toBe("min(tool_call_count) with tie-breakers");
  });
});
