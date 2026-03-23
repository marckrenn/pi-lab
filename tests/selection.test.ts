import { describe, expect, test } from "bun:test";
import { rankDeterministicLanes } from "../pi-extension/ab/selection.ts";

const baseExperiment = {
  id: "e",
  target_tool: "calculator",
  trigger: { tool: "calculator" },
  mode: "deterministic",
  execution_strategy: "fixed_args",
  lanes: [
    { id: "A", primary: true, extensions: [] },
    { id: "B", primary: false, extensions: [] },
  ],
  selection: {
    deterministic: {
      objective: "max(success)",
      tie_breakers: [],
    },
  },
} as const;

describe("deterministic ranking comparator", () => {
  test("compareWithoutIdFallback returns tie while compare remains stable", () => {
    const lanes = [
      { lane_id: "A", status: "success" as const },
      { lane_id: "B", status: "success" as const },
    ];

    const ranking = rankDeterministicLanes(baseExperiment as any, lanes as any);
    expect(ranking.compareWithoutIdFallback(lanes[0] as any, lanes[1] as any)).toBe(0);
    expect(ranking.compare(lanes[0] as any, lanes[1] as any)).toBeLessThan(0);
  });
});
