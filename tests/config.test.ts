import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { canonicalExecutionStrategy, deactivateBuiltinToolsOf, loadExperiments, setExperimentEnabled, validateExperimentConfig } from "../pi-extension/lab/config.ts";

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
    const cwd = mkdtempSync(join(tmpdir(), "lab-config-extra-"));
    const projectDir = join(cwd, ".pi", "lab", "experiments");
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

  test("loads project experiments from .pi/lab/experiments", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lab-config-local-"));
    const labDir = join(cwd, ".pi", "lab", "experiments");
    mkdirSync(labDir, { recursive: true });

    writeFileSync(
      join(labDir, "local.json"),
      JSON.stringify({
        ...mkExp("shared", "edit_compare"),
        winner: { mode: "blend" },
      }),
    );

    const experiments = loadExperiments(cwd);
    expect(experiments).toHaveLength(1);
    expect(experiments[0]?.source).toBe("project");
    expect(experiments[0]?.path).toBe(join(labDir, "local.json"));
    expect(experiments[0]?.experiment.tool.name).toBe("edit_compare");
  });

  test("can toggle experiment enabled state in-place", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lab-config-toggle-"));
    const dir = join(cwd, ".pi", "lab", "experiments");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "toggle.json");
    writeFileSync(path, JSON.stringify({ ...mkExp("toggle-me", "edit"), enabled: true }, null, 2));

    expect(setExperimentEnabled(path, "toggle-me", false)).toEqual({ found: true, enabled: false });
    expect(JSON.parse(readFileSync(path, "utf8")).enabled).toBe(false);
    expect(setExperimentEnabled(path, "toggle-me", true)).toEqual({ found: true, enabled: true });
    expect(JSON.parse(readFileSync(path, "utf8")).enabled).toBe(true);
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

  test("loads deactivate_builtin_tools and normalizes duplicates", () => {
    const experiment = {
      id: "x",
      tool: { name: "edit" },
      deactivate_builtin_tools: ["edit", " bash ", "edit"],
      winner: { mode: "formula" },
      lanes: [{ id: "A", baseline: true, extensions: ["./a.ts"] }],
    } as any;

    expect(deactivateBuiltinToolsOf(experiment)).toEqual(["edit", "bash"]);
  });

  test("validates deactivate_builtin_tools entries", () => {
    const badType = validateExperimentConfig({
      id: "x",
      tool: { name: "edit" },
      deactivate_builtin_tools: "edit",
      winner: { mode: "formula" },
      lanes: [{ id: "A", baseline: true, extensions: ["./a.ts"] }],
    } as any);
    expect(badType.errors.some((e) => e.includes("deactivate_builtin_tools must be an array"))).toBe(true);

    const unknownBuiltin = validateExperimentConfig({
      id: "x",
      tool: { name: "edit" },
      deactivate_builtin_tools: ["planner"],
      winner: { mode: "formula" },
      lanes: [{ id: "A", baseline: true, extensions: ["./a.ts"] }],
    } as any);
    expect(unknownBuiltin.warnings.some((w) => w.includes("not a known builtin tool name"))).toBe(true);
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

  test("loads optional lane model and thinking overrides", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lab-config-model-"));
    const dir = join(cwd, ".pi", "lab", "experiments");
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "model.json"),
      JSON.stringify({
        id: "model-test",
        tool: { name: "planner" },
        execution: { strategy: "lane_multi_call" },
        winner: { mode: "formula" },
        lanes: [{ id: "A", baseline: true, model: "openai/gpt-5", thinking: "high", extensions: ["./a.ts"] }],
      }),
    );

    const loaded = loadExperiments(cwd);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].experiment.lanes[0]?.model).toBe("openai/gpt-5");
    expect(loaded[0].experiment.lanes[0]?.thinking).toBe("high");
    expect(loaded[0].validation?.errors ?? []).toEqual([]);
  });

  test("rejects invalid lane thinking overrides", () => {
    const result = validateExperimentConfig({
      id: "x",
      tool: { name: "planner" },
      winner: { mode: "formula" },
      lanes: [{ id: "A", baseline: true, thinking: "turbo", extensions: ["./a.ts"] }],
    } as any);

    expect(result.errors.some((e) => e.includes("thinking must be one of"))).toBe(true);
  });

  test("rejects legacy fields after load normalization", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lab-config-"));
    const dir = join(cwd, ".pi", "lab", "experiments");
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
