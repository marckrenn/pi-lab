import { describe, expect, test } from "bun:test";
import { rankFormulaLanes } from "../pi-extension/ab/selection.ts";

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
});
