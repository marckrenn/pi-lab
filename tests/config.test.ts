import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { canonicalExecutionStrategy, loadExperiments, validateExperimentConfig } from "../pi-extension/ab/config.ts";

function mkExp(id: string, tool: string, winner: string = "formula") {
  return {
    id,
    tool: { name: tool },
    winner: { mode: winner },
    lanes: [{ id: "A", baseline: true, extensions: ["./a.ts"] }],
  };
}

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

describe("config loading", () => {
  test("supports extra experiment dirs with project override precedence", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ab-config-extra-"));
    const projectDir = join(cwd, ".pi", "ab", "experiments");
    const packageDir = join(cwd, "pkg-experiments");
    const packageOverrideDir = join(cwd, "pkg-override");

    mkdirSync(projectDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(packageOverrideDir, { recursive: true });

    writeFileSync(join(projectDir, "local.json"), JSON.stringify(mkExp("local", "edit")));
    writeFileSync(join(packageDir, "shared.json"), JSON.stringify(mkExp("shared", "edit")));
    writeFileSync(join(packageOverrideDir, "shared.json"), JSON.stringify(mkExp("shared", "edit")));
    writeFileSync(join(packageOverrideDir, "shadow.json"), JSON.stringify(mkExp("shadow", "edit")));

    writeFileSync(
      join(projectDir, "shadow.json"),
      JSON.stringify({
        id: "shadow",
        tool: { name: "edit" },
        winner: { mode: "formula" },
        lanes: [{ id: "P", baseline: true, extensions: ["./override.ts"] }],
      }),
    );

    const experiments = loadExperiments(cwd, {
      experimentDirs: [
        packageDir,
        packageOverrideDir,
      ],
    });

    const byId = new Map(experiments.map((ex) => [ex.experiment.id, ex]));
    const shared = byId.get("shared");
    const shadow = byId.get("shadow");
    const local = byId.get("local");

    expect(shared?.source).toBe(`package:${resolve(packageOverrideDir)}`);
    expect(shadow?.source).toBe("project");
    expect(local?.source).toBe("project");
    expect(experiments.some((ex) => ex.experiment.id === "local")).toBe(true);
    expect(experiments.some((ex) => ex.experiment.id === "shadow")).toBe(true);
  });

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
