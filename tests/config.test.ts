import { describe, expect, test } from "bun:test";
import { canonicalExecutionStrategy, validateExperimentConfig } from "../pi-extension/ab/config.ts";

describe("config strategy canonicalization", () => {
  test("maps valid strategies", () => {
    expect(canonicalExecutionStrategy(undefined)).toBe("fixed_args");
    expect(canonicalExecutionStrategy("fixed_args")).toBe("fixed_args");
    expect(canonicalExecutionStrategy("lane_single_call")).toBe("lane_single_call");
    expect(canonicalExecutionStrategy("lane_multi_call")).toBe("lane_multi_call");
  });

  test("rejects unsupported strategy", () => {
    expect(canonicalExecutionStrategy("lane_replan")).toBe("invalid");
  });
});

describe("config validation", () => {
  test("warns on path regex for proxy strategies", () => {
    const result = validateExperimentConfig({
      id: "x",
      target_tool: "calculator",
      trigger: { tool: "calculator", when_path_regex: "^src/" },
      mode: "deterministic",
      execution_strategy: "lane_multi_call",
      lanes: [{ id: "A", extensions: ["./a.ts"] }],
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("when_path_regex"))).toBe(true);
  });
});
