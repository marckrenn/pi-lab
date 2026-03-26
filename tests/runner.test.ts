import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DIRECT_HARNESS_FALLBACK_REASONS,
  DirectLaneHarnessError,
  detectGitRepository,
  directHarnessFallbackReasonForError,
  loadLaneToolsDirect,
  resolveLaneModelOverride,
  runBaselineFixedArgsFallbackNoGit,
  runExperimentLanesFixedArgsTool,
} from "../pi-extension/lab/runner.ts";
import type { LaneConfig, LoadedExperiment } from "../pi-extension/lab/types.ts";

describe("direct lane harness extension compatibility checks", () => {
  const tmpRoots: string[] = [];

  const createTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-runner-test-"));
    tmpRoots.push(dir);
    return dir;
  };

  afterEach(() => {
    while (tmpRoots.length > 0) {
      const dir = tmpRoots.pop();
      if (!dir) continue;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadLaneToolsDirect fails fast when unsupported pi API is accessed", async () => {
    const dir = createTempDir();
    const laneDir = join(dir, "lanes");
    mkdirSync(laneDir);

    const extensionPath = join(laneDir, "unsupported.ts");
    writeFileSync(
      extensionPath,
      [
        "export default function lane(pi) {",
        "  pi.registerTool({",
        "    name: 'direct-test',",
        "    description: 'direct harness unsupported API detection',",
        "    parameters: { type: 'object', additionalProperties: false, properties: {} },",
        "    async execute(toolCallId, params) {",
        "      return { content: [{ type: 'text', text: 'ok' }] };",
        "    },",
        "  });",
        "  pi.on('session_start', () => {});",
        "}",
      ].join("\n"),
      "utf8",
    );

    const lane: LaneConfig = {
      id: "A",
      baseline: true,
      extensions: [extensionPath],
    };

    await expect(loadLaneToolsDirect(lane, dir, dir, join(dir, "worktree"))).rejects.toBeInstanceOf(DirectLaneHarnessError);
  });

  test("direct harness fallback reason helper returns explicit reason for unsupported API", () => {
    const err = new DirectLaneHarnessError(
      "unsupported api",
      DIRECT_HARNESS_FALLBACK_REASONS.unsupportedExtensionApi,
    );

    expect(directHarnessFallbackReasonForError(err)).toBe(DIRECT_HARNESS_FALLBACK_REASONS.unsupportedExtensionApi);
    expect(directHarnessFallbackReasonForError(new Error("generic"))).toBe(DIRECT_HARNESS_FALLBACK_REASONS.failed);
  });

  test("detectGitRepository reports non-git workspaces clearly", async () => {
    const dir = createTempDir();
    const detected = await detectGitRepository(dir);

    expect(detected.ok).toBe(false);
    if (!detected.ok) {
      expect(detected.error).toContain("not a git repository");
    }
  });

  test("resolveLaneModelOverride prefers explicit lane model and otherwise inherits the main model", () => {
    expect(resolveLaneModelOverride({ id: "A", extensions: ["./lane.ts"], model: "anthropic/claude-sonnet-4-6" }, "openai/gpt-5")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(resolveLaneModelOverride({ id: "B", extensions: ["./lane.ts"] }, "openai/gpt-5")).toBe("openai/gpt-5");
    expect(resolveLaneModelOverride({ id: "C", extensions: ["./lane.ts"] }, undefined)).toBeUndefined();
  });

  test("fixed_args no-git fallback runs the baseline lane in-place", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "sample.txt"), "alpha\nbeta\ngamma\n", "utf8");

    const extensionPath = join(dir, "lane.ts");
    writeFileSync(
      extensionPath,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import { resolve } from "node:path";',
        'import { Type } from "@sinclair/typebox";',
        'export default function lane(pi) {',
        '  pi.registerTool({',
        '    name: "edit_compare",',
        '    label: "edit_compare",',
        '    description: "test tool",',
        '    parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),',
        '    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {',
        '      const filePath = resolve(ctx?.cwd ?? process.cwd(), String(params.path));',
        '      const before = readFileSync(filePath, "utf8");',
        '      writeFileSync(filePath, before.replace(String(params.oldText), String(params.newText)), "utf8");',
        '      return { content: [{ type: "text", text: "ok" }] };',
        '    },',
        '  });',
        '}',
      ].join("\n"),
      "utf8",
    );

    const loaded: LoadedExperiment = {
      source: "project",
      path: extensionPath,
      validation: { errors: [], warnings: [] },
      experiment: {
        id: "fixed-args-no-git-fallback-test",
        tool: { name: "edit_compare" },
        execution: { strategy: "fixed_args", timeout_ms: 30_000 },
        winner: { mode: "hardcoded", hardcoded_lane: "baseline" },
        lanes: [{ id: "baseline", baseline: true, extensions: [extensionPath] }],
      },
    };

    const runDir = createTempDir();
    const fallback = await runBaselineFixedArgsFallbackNoGit(
      loaded,
      { runId: "test-run", dir: runDir },
      dir,
      "edit_compare",
      { path: "sample.txt", oldText: "beta", newText: "BETA" },
    );

    expect(fallback.lane.status).toBe("success");
    expect(fallback.patchText).toContain("sample.txt");
    expect(readFileSync(join(dir, "sample.txt"), "utf8")).toContain("BETA");
  }, 15000);

  test("fixed_args direct lanes capture a patch for winner mergeback", async () => {
    const dir = createTempDir();
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "pi@example.com"', { cwd: dir, stdio: "ignore" });
    execSync('git config user.name "Pi Test"', { cwd: dir, stdio: "ignore" });

    writeFileSync(join(dir, "sample.txt"), "alpha\nbeta\ngamma\n", "utf8");

    const extensionPath = join(dir, "lane.ts");
    writeFileSync(
      extensionPath,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import { resolve } from "node:path";',
        'import { Type } from "@sinclair/typebox";',
        'export default function lane(pi) {',
        '  pi.registerTool({',
        '    name: "edit_compare",',
        '    label: "edit_compare",',
        '    description: "test tool",',
        '    parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),',
        '    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {',
        '      const filePath = resolve(ctx?.cwd ?? process.cwd(), String(params.path));',
        '      const before = readFileSync(filePath, "utf8");',
        '      writeFileSync(filePath, before.replace(String(params.oldText), String(params.newText)), "utf8");',
        '      return { content: [{ type: "text", text: "ok" }] };',
        '    },',
        '  });',
        '}',
      ].join("\n"),
      "utf8",
    );

    execSync("git add .", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });

    const loaded: LoadedExperiment = {
      source: "project",
      path: extensionPath,
      validation: { errors: [], warnings: [] },
      experiment: {
        id: "fixed-args-patch-test",
        tool: { name: "edit_compare" },
        execution: { strategy: "fixed_args", timeout_ms: 30_000 },
        winner: { mode: "hardcoded", hardcoded_lane: "baseline" },
        lanes: [{ id: "baseline", baseline: true, extensions: [extensionPath] }],
      },
    };

    const runDir = createTempDir();
    mkdirSync(runDir, { recursive: true });

    const result = await runExperimentLanesFixedArgsTool(
      loaded,
      { runId: "test-run", dir: runDir },
      dir,
      "edit_compare",
      { path: "sample.txt", oldText: "beta", newText: "BETA" },
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0].status).toBe("success");
    expect(result.records[0].patch_bytes).toBeGreaterThan(0);
    expect(existsSync(result.records[0].patch_path!)).toBe(true);
    expect(readFileSync(result.records[0].patch_path!, "utf8")).toContain("sample.txt");
  }, 15000);
});
