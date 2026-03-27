import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DIRECT_HARNESS_FALLBACK_REASONS,
  DirectLaneHarnessError,
  detectGitRepository,
  directHarnessFallbackReasonForError,
  loadLaneToolsDirect,
  resolveEditExecutionContext,
  resolveFlowToolExecutionContext,
  resolveLaneModelOverride,
  resolveLaneThinkingOverride,
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

  test("resolveEditExecutionContext switches to the target file git repo for absolute paths", async () => {
    const callerRepo = createTempDir();
    const targetRepo = createTempDir();
    execSync("git init", { cwd: callerRepo, stdio: "ignore" });
    execSync("git init", { cwd: targetRepo, stdio: "ignore" });

    mkdirSync(join(targetRepo, "playground"), { recursive: true });
    const targetFile = join(targetRepo, "playground", "article.md");
    writeFileSync(targetFile, "hello\n", "utf8");

    const resolved = await resolveEditExecutionContext(callerRepo, targetFile);

    expect(realpathSync(resolved.executionCwd)).toBe(realpathSync(targetRepo));
    expect(realpathSync(resolved.applyCwd)).toBe(realpathSync(targetRepo));
    expect(resolved.normalizedPath).toBe("playground/article.md");
    expect(realpathSync(resolved.targetFilePath)).toBe(realpathSync(targetFile));
    expect(resolved.targetGit.ok).toBe(true);
  });

  test("resolveEditExecutionContext falls back to the target parent dir for absolute non-git paths", async () => {
    const callerRepo = createTempDir();
    const externalDir = createTempDir();
    execSync("git init", { cwd: callerRepo, stdio: "ignore" });

    const targetFile = join(externalDir, "note.md");
    writeFileSync(targetFile, "hello\n", "utf8");

    const resolved = await resolveEditExecutionContext(callerRepo, targetFile);

    expect(realpathSync(resolved.executionCwd)).toBe(realpathSync(externalDir));
    expect(realpathSync(resolved.applyCwd)).toBe(realpathSync(externalDir));
    expect(resolved.normalizedPath).toBe("note.md");
    expect(realpathSync(resolved.targetFilePath)).toBe(realpathSync(targetFile));
    expect(resolved.targetGit.ok).toBe(false);
  });

  test("resolveFlowToolExecutionContext rewrites cross-repo edit flow prompts to the target repo path", async () => {
    const callerRepo = createTempDir();
    const targetRepo = createTempDir();
    execSync("git init", { cwd: callerRepo, stdio: "ignore" });
    execSync("git init", { cwd: targetRepo, stdio: "ignore" });

    mkdirSync(join(targetRepo, "playground"), { recursive: true });
    const targetFile = join(targetRepo, "playground", "basic.txt");
    writeFileSync(targetFile, "alpha\n", "utf8");

    const resolved = await resolveFlowToolExecutionContext(
      callerRepo,
      "edit",
      {
        task: "Apply harmless dummy edits to the target file.",
        context: `Previously I edited ${targetFile} in another repo.`,
        constraints: `Only modify ${targetFile}. Keep the edits simple.`,
      },
    );

    expect(realpathSync(resolved.executionCwd)).toBe(realpathSync(targetRepo));
    expect(realpathSync(resolved.applyCwd)).toBe(realpathSync(targetRepo));
    expect(resolved.matchedPath).toBe(targetFile);
    expect(resolved.normalizedPath).toBe("playground/basic.txt");
    expect(realpathSync(resolved.targetFilePath ?? targetFile)).toBe(realpathSync(targetFile));
    expect(resolved.flowArgs.constraints).toContain("playground/basic.txt");
    expect(resolved.flowArgs.constraints).not.toContain(targetFile);
    expect(resolved.flowArgs.context).toContain("playground/basic.txt");
    expect(resolved.flowArgs.context).not.toContain(targetFile);
  });

  test("resolveFlowToolExecutionContext honors explicit edit path even when task text has no path", async () => {
    const callerRepo = createTempDir();
    const targetRepo = createTempDir();
    execSync("git init", { cwd: callerRepo, stdio: "ignore" });
    execSync("git init", { cwd: targetRepo, stdio: "ignore" });

    mkdirSync(join(targetRepo, "playground"), { recursive: true });
    const targetFile = join(targetRepo, "playground", "basic.txt");
    writeFileSync(targetFile, "alpha\n", "utf8");

    const resolved = await resolveFlowToolExecutionContext(callerRepo, "edit", {
      task: "Make a few harmless dummy edits to this text file.",
      path: targetFile,
      context: "Current file has four short placeholder lines.",
      constraints: "Keep it plain text and make small obvious dummy changes only.",
    });

    expect(realpathSync(resolved.executionCwd)).toBe(realpathSync(targetRepo));
    expect(realpathSync(resolved.applyCwd)).toBe(realpathSync(targetRepo));
    expect(resolved.matchedPath).toBe(targetFile);
    expect(resolved.normalizedPath).toBe("playground/basic.txt");
    expect(resolved.flowArgs.path).toBe("playground/basic.txt");
  });

  test("resolveFlowToolExecutionContext leaves edit flow prompts unchanged when target paths are ambiguous", async () => {
    const callerRepo = createTempDir();
    const targetRepoA = createTempDir();
    const targetRepoB = createTempDir();
    execSync("git init", { cwd: callerRepo, stdio: "ignore" });
    execSync("git init", { cwd: targetRepoA, stdio: "ignore" });
    execSync("git init", { cwd: targetRepoB, stdio: "ignore" });

    mkdirSync(join(targetRepoA, "playground"), { recursive: true });
    mkdirSync(join(targetRepoB, "playground"), { recursive: true });
    const targetFileA = join(targetRepoA, "playground", "a.txt");
    const targetFileB = join(targetRepoB, "playground", "b.txt");
    writeFileSync(targetFileA, "a\n", "utf8");
    writeFileSync(targetFileB, "b\n", "utf8");

    const flowArgs = {
      task: `Touch ${targetFileA} and ${targetFileB}.`,
      constraints: `Only modify ${targetFileA} or ${targetFileB}.`,
    };

    const resolved = await resolveFlowToolExecutionContext(callerRepo, "edit", flowArgs);

    expect(realpathSync(resolved.executionCwd)).toBe(realpathSync(callerRepo));
    expect(realpathSync(resolved.applyCwd)).toBe(realpathSync(callerRepo));
    expect(resolved.matchedPath).toBeUndefined();
    expect(resolved.normalizedPath).toBeUndefined();
    expect(resolved.flowArgs).toEqual(flowArgs);
  });

  test("resolveFlowToolExecutionContext ignores slash-words like dummy/test and wording/casing", async () => {
    const callerRepo = createTempDir();
    const targetRepo = createTempDir();
    execSync("git init", { cwd: callerRepo, stdio: "ignore" });
    execSync("git init", { cwd: targetRepo, stdio: "ignore" });

    mkdirSync(join(targetRepo, "playground"), { recursive: true });
    const targetFile = join(targetRepo, "playground", "basic.txt");
    writeFileSync(targetFile, "alpha\n", "utf8");

    const resolved = await resolveFlowToolExecutionContext(callerRepo, "edit", {
      task: "Make harmless dummy/test edits and tweak wording/casing on a couple of lines.",
      context: `Current file is ${targetFile}.`,
      constraints: `Only modify ${targetFile}. Keep the edits simple.`,
    });

    expect(realpathSync(resolved.executionCwd)).toBe(realpathSync(targetRepo));
    expect(resolved.matchedPath).toBe(targetFile);
    expect(resolved.normalizedPath).toBe("playground/basic.txt");
    expect(resolved.flowArgs.task).toContain("dummy/test");
    expect(resolved.flowArgs.task).toContain("wording/casing");
  });

  test("resolveLaneModelOverride prefers explicit lane model and otherwise inherits the main model", () => {
    expect(resolveLaneModelOverride({ id: "A", extensions: ["./lane.ts"], model: "anthropic/claude-sonnet-4-6" }, "openai/gpt-5")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(resolveLaneModelOverride({ id: "B", extensions: ["./lane.ts"] }, "openai/gpt-5")).toBe("openai/gpt-5");
    expect(resolveLaneModelOverride({ id: "C", extensions: ["./lane.ts"] }, undefined)).toBeUndefined();
  });

  test("resolveLaneThinkingOverride prefers explicit lane thinking and otherwise inherits the main thinking level", () => {
    expect(resolveLaneThinkingOverride({ id: "A", extensions: ["./lane.ts"], thinking: "high" }, "low")).toBe("high");
    expect(resolveLaneThinkingOverride({ id: "B", extensions: ["./lane.ts"] }, "low")).toBe("low");
    expect(resolveLaneThinkingOverride({ id: "C", extensions: ["./lane.ts"] }, undefined)).toBeUndefined();
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
