import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { canonicalExecutionStrategy, loadExperiments, validateExperimentConfig } from "../pi-extension/ab/config.ts";

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
      tool: { name: "calculator" },
      trigger: { when_path_regex: "^src/" },
      winner: { mode: "formula" },
      execution: { strategy: "lane_multi_call" },
      lanes: [{ id: "A", label: "A", baseline: true, extensions: ["./a.ts"] }],
    } as any);

    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("when_path_regex"))).toBe(true);
  });


  test("rejects lane ids with unsupported characters", () => {
    const result = validateExperimentConfig({
      id: "x",
      tool: { name: "edit" },
      winner: { mode: "formula" },
      lanes: [{ id: "bad/id", extensions: ["./a.ts"] }],
    } as any);

    expect(result.errors.some((e) => e.includes("contains unsupported characters"))).toBe(true);
  });


  test("requires winner.hardcoded_lane in hardcoded mode", () => {
    const result = validateExperimentConfig({
      id: "x",
      tool: { name: "edit" },
      winner: { mode: "hardcoded" },
      lanes: [{ id: "A", baseline: true, extensions: ["./a.ts"] }],
    } as any);

    expect(result.errors.some((e) => e.includes("winner.hardcoded_lane is required"))).toBe(true);
  });

  test("rejects invalid trigger.when_path_regex", () => {
    const result = validateExperimentConfig({
      id: "x",
      tool: { name: "edit" },
      trigger: { when_path_regex: "[" },
      winner: { mode: "formula" },
      lanes: [{ id: "A", baseline: true, extensions: ["./a.ts"] }],
    } as any);

    expect(result.errors.some((e) => e.includes("valid regular expression"))).toBe(true);
  });

  test("rejects legacy fields after load normalization", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ab-config-"));
    const dir = join(cwd, ".pi", "ab", "experiments");
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "legacy.json"),
      JSON.stringify({
        id: "legacy",
        enabled: true,
        tool: { name: "edit" },
        winner_mode: "formula",
        execution_strategy: "fixed_args",
        trigger: { tool: "edit" },
        debug: false,
        lanes: [{ id: "A", extensions: ["./a.ts"] }],
      }),
    );

    const loaded = loadExperiments(cwd);
    expect(loaded).toHaveLength(1);
    const errors = loaded[0].validation?.errors ?? [];

    expect(errors.some((e) => e.includes("winner_mode"))).toBe(true);
    expect(errors.some((e) => e.includes("execution_strategy"))).toBe(true);
    expect(errors.some((e) => e.includes("trigger.tool"))).toBe(true);
    expect(errors.some((e) => e.includes("debug must now be an object"))).toBe(true);
    expect(errors.some((e) => e.includes("winner.mode is required"))).toBe(true);
  });
});
