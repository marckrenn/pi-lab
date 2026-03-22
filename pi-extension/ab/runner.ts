import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEditTool } from "@mariozechner/pi-coding-agent";
import type { LoadedExperiment, LaneConfig, LaneRunRecord } from "./types.ts";
import { resolveConfiguredPath } from "./config.ts";
import type { RunContext } from "./storage.ts";
import { runCommand, safeJsonParse } from "./utils.ts";
import {
  closeCmuxSurface,
  closeCmuxSurfacesByTitlePrefix,
  createCmuxSurface,
  findCmuxSurfaceByTitle,
  isCmuxAvailable,
  readCmuxScreen,
  sendCmuxCommand,
  shellEscape,
  waitForCmuxSentinel,
} from "./mux.ts";

interface SessionMessageEntry {
  type: "message";
  message: {
    role: string;
    toolName?: string;
    isError?: boolean;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      arguments?: { path?: string; oldText?: string; newText?: string };
    }>;
    usage?: { totalTokens?: number };
  };
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function relativeTargetPath(cwd: string, inputPath: string): string {
  if (inputPath.startsWith("/")) return toPosixPath(relative(cwd, inputPath));
  return toPosixPath(inputPath);
}

async function gitOutput(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const res = await runCommand("git", args, { cwd, signal, timeoutMs: 15000 });
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trimEnd();
}

async function getRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  return (await gitOutput(cwd, ["rev-parse", "--show-toplevel"], signal)).trim();
}

async function getHeadSha(repoRoot: string, signal?: AbortSignal): Promise<string> {
  return (await gitOutput(repoRoot, ["rev-parse", "HEAD"], signal)).trim();
}


function newestSessionFile(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.file;
}

function parseLaneSession(
  sessionFile: string | undefined,
  expectedEditArgs: { path: string; oldText: string; newText: string },
): {
  outputText?: string;
  isError?: boolean;
  totalTokens?: number;
  editCallCount: number;
  exactEditArgsMatch: boolean;
  laneDone: boolean;
} {
  if (!sessionFile || !existsSync(sessionFile)) {
    return { editCallCount: 0, exactEditArgsMatch: false, laneDone: false };
  }

  const lines = readFileSync(sessionFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let lastEditResult: SessionMessageEntry["message"] | undefined;
  let lastAssistant: SessionMessageEntry["message"] | undefined;
  let editCallCount = 0;
  let exactEditArgsMatch = false;

  for (const line of lines) {
    const parsed = safeJsonParse<SessionMessageEntry>(line);
    if (!parsed || parsed.type !== "message") continue;

    if (parsed.message.role === "assistant") {
      lastAssistant = parsed.message;
      for (const block of parsed.message.content ?? []) {
        if (block.type !== "toolCall" || block.name !== "edit") continue;
        editCallCount += 1;
        const args = block.arguments;
        if (
          args?.path === expectedEditArgs.path &&
          args?.oldText === expectedEditArgs.oldText &&
          args?.newText === expectedEditArgs.newText
        ) {
          exactEditArgsMatch = true;
        }
      }
    }

    if (parsed.message.role === "toolResult" && parsed.message.toolName === "edit") {
      lastEditResult = parsed.message;
    }
  }

  const outputText = (lastEditResult?.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const assistantText = (lastAssistant?.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    outputText: outputText || undefined,
    isError: lastEditResult?.isError,
    totalTokens: lastAssistant?.usage?.totalTokens,
    editCallCount,
    exactEditArgsMatch,
    laneDone: assistantText === "LANE_DONE",
  };
}

interface DirectLaneTool {
  name: string;
  execute: (
    toolCallId: string,
    params: { path: string; oldText: string; newText: string },
    signal?: AbortSignal,
    onUpdate?: any,
    ctx?: any,
  ) => Promise<any>;
}

let laneCwdLock: Promise<void> = Promise.resolve();

async function withLaneProcessCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  let release: (() => void) | undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });

  const previous = laneCwdLock;
  laneCwdLock = laneCwdLock.then(() => next);

  await previous;

  const originalCwd = process.cwd();
  let changed = false;
  try {
    process.chdir(cwd);
    changed = true;
    return await fn();
  } finally {
    if (changed) {
      process.chdir(originalCwd);
    }
    release?.();
  }
}

function createLaneExtensionApi(toolRegistry: Map<string, DirectLaneTool>): any {
  const noop = () => undefined;

  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "registerTool") {
          return (tool: any) => {
            if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") return;
            toolRegistry.set(tool.name, tool as DirectLaneTool);
          };
        }
        if (prop === "getActiveTools") {
          return () => [...toolRegistry.keys()];
        }
        if (prop === "getAllTools") {
          return () => [...toolRegistry.values()].map((tool) => ({ name: tool.name, description: "" }));
        }
        if (prop === "getFlag") {
          return () => undefined;
        }
        if (prop === "setModel") {
          return async () => false;
        }
        return noop;
      },
    },
  );
}

async function loadLaneToolsDirect(
  lane: LaneConfig,
  cwd: string,
  loadedPath: string,
  worktreePath: string,
): Promise<Map<string, DirectLaneTool>> {
  const toolRegistry = new Map<string, DirectLaneTool>();
  toolRegistry.set("edit", createEditTool(worktreePath) as unknown as DirectLaneTool);

  const fakePi = createLaneExtensionApi(toolRegistry);

  for (const extension of lane.extensions) {
    const resolved = resolveConfiguredPath(extension, cwd, loadedPath);
    const moduleUrl = `${pathToFileURL(resolved).href}?ab_lane=${encodeURIComponent(lane.id)}&t=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mod = await import(moduleUrl);
    const init = typeof mod?.default === "function" ? mod.default : undefined;
    if (!init) {
      throw new Error(`Lane extension does not export a default function: ${resolved}`);
    }
    await init(fakePi);
  }

  return toolRegistry;
}

function toolResultText(result: any): string | undefined {
  const text = (result?.content ?? [])
    .filter((b: any) => b?.type === "text" && typeof b?.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
  return text || undefined;
}

async function runLaneDirect(
  lane: LaneConfig,
  options: {
    cwd: string;
    loadedPath: string;
    worktreePath: string;
    editArgs: { path: string; oldText: string; newText: string };
    signal?: AbortSignal;
  },
): Promise<{ outputText?: string; isError: boolean; errorText?: string; timedOut: boolean; code: number; latencyMs: number }> {
  return withLaneProcessCwd(options.worktreePath, async () => {
    const started = Date.now();
    const tools = await loadLaneToolsDirect(lane, options.cwd, options.loadedPath, options.worktreePath);
    const editTool = tools.get("edit");
    if (!editTool) {
      throw new Error(`Direct lane harness could not resolve an edit tool for lane ${lane.id}.`);
    }

    try {
      const result = await editTool.execute(
        `ab-lane-${lane.id}`,
        {
          path: options.editArgs.path,
          oldText: options.editArgs.oldText,
          newText: options.editArgs.newText,
        },
        options.signal,
        undefined,
        { cwd: options.worktreePath },
      );

      return {
        outputText: toolResultText(result),
        isError: false,
        timedOut: false,
        code: 0,
        latencyMs: Date.now() - started,
      };
    } catch (err: any) {
      return {
        outputText: err?.message ?? String(err),
        isError: true,
        errorText: err?.message ?? String(err),
        timedOut: false,
        code: 0,
        latencyMs: Date.now() - started,
      };
    }
  });
}

function lanePrompt(lane: LaneConfig, editArgs: { path: string; oldText: string; newText: string }): string {
  const exactArgs = JSON.stringify({
    path: editArgs.path,
    oldText: editArgs.oldText,
    newText: editArgs.newText,
  });

  return [
    `You are lane ${lane.id} in an A/B experiment.`,
    "Execute EXACTLY ONE edit tool call.",
    "Use the EXACT JSON arguments below without modifications (no trimming, no added newlines, no escaping changes).",
    "Do not call any other mutating tools.",
    "After the edit tool call, respond with: LANE_DONE",
    "",
    `EXACT_EDIT_ARGS_JSON: ${exactArgs}`,
  ].join("\n");
}

function normalizeNoIndexPatchPaths(patch: string, relPath: string): string {
  if (!patch.trim()) return patch;

  const lines = patch.split("\n");
  const normalized = lines.map((line) => {
    if (line.startsWith("diff --git a/") && line.includes(" b/")) {
      return `diff --git a/${relPath} b/${relPath}`;
    }
    if (line.startsWith("--- a/")) return `--- a/${relPath}`;
    if (line.startsWith("+++ b/")) return `+++ b/${relPath}`;
    return line;
  });
  return normalized.join("\n");
}

async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await runCommand("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
    timeoutMs: 15000,
  });
}

async function runLanePi(
  piArgs: string[],
  options: {
    worktreePath: string;
    timeoutMs: number;
    signal?: AbortSignal;
    surface?: string;
  },
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean; timedOut: boolean }> {
  if (!options.surface) {
    return runCommand("pi", piArgs, {
      cwd: options.worktreePath,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      env: { ...process.env, PI_AB_LANE: "1" },
    });
  }

  const sentinel = "__PI_AB_DONE_";
  const piCmd = ["PI_AB_LANE=1", "pi", ...piArgs.map((a) => shellEscape(a))].join(" ");
  const cmd = `cd ${shellEscape(options.worktreePath)} && ${piCmd}; echo '${sentinel}'$?'__'`;

  sendCmuxCommand(options.surface, cmd);
  const waited = await waitForCmuxSentinel(options.surface, sentinel, options.timeoutMs, options.signal);

  const timedOut = waited.exitCode === 124;
  const screen = waited.screen || readCmuxScreen(options.surface, 300);

  return {
    stdout: screen,
    stderr: timedOut ? "Lane timed out in cmux mode" : "",
    code: timedOut ? 124 : waited.exitCode,
    killed: timedOut,
    timedOut,
  };
}

export async function applyPatchToMain(
  cwd: string,
  patchPath: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; method?: "apply" | "3way"; error?: string }> {
  const first = await runCommand("git", ["apply", "--whitespace=nowarn", patchPath], {
    cwd,
    timeoutMs: 15000,
    signal,
  });
  if (first.code === 0) return { ok: true, method: "apply" };

  const second = await runCommand("git", ["apply", "--3way", "--whitespace=nowarn", patchPath], {
    cwd,
    timeoutMs: 15000,
    signal,
  });
  if (second.code === 0) return { ok: true, method: "3way" };

  return {
    ok: false,
    error: [first.stderr || first.stdout, second.stderr || second.stdout].filter(Boolean).join("\n\n"),
  };
}

export async function runExperimentLanes(
  loaded: LoadedExperiment,
  run: RunContext,
  cwd: string,
  sessionFile: string | null,
  editArgs: { path: string; oldText: string; newText: string },
  signal?: AbortSignal,
): Promise<LaneRunRecord[]> {
  const experiment = loaded.experiment;
  const timeoutMs = experiment.timeout_ms ?? 15000;
  const repoRoot = await getRepoRoot(cwd, signal);
  const headSha = await getHeadSha(repoRoot, signal);
  const relPath = relativeTargetPath(cwd, resolve(cwd, editArgs.path));

  const sourceTargetPath = resolve(cwd, editArgs.path);

  const policy = experiment.failure_policy ?? {};
  const abortController = new AbortController();
  signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const keepDebugPanes = process.env.PI_AB_KEEP_PANES === "1";
  const debugUiMode = (process.env.PI_AB_DEBUG_UI ?? experiment.debug_ui ?? "none").toLowerCase();
  const requestedLaneHarness = (process.env.PI_AB_LANE_HARNESS ?? experiment.lane_harness ?? "direct").toLowerCase();

  let useCmuxDebug =
    requestedLaneHarness === "pi_prompt" &&
    experiment.debug === true &&
    debugUiMode !== "none" &&
    isCmuxAvailable();
  const laneSurfaces: Array<string | undefined> = [];
  if (useCmuxDebug) {
    try {
      for (let i = 0; i < experiment.lanes.length; i++) {
        const lane = experiment.lanes[i];
        const surface =
          i === 0
            ? createCmuxSurface(`AB Lane ${lane.id}`, "right")
            : createCmuxSurface(`AB Lane ${lane.id}`, "down", laneSurfaces[i - 1]);
        laneSurfaces.push(surface);
      }
    } catch {
      try {
        closeCmuxSurfacesByTitlePrefix("AB Lane ");
      } catch {}
      useCmuxDebug = false;
      laneSurfaces.length = 0;
    }
  }

  const lanePromises = experiment.lanes.map(async (lane, laneIndex): Promise<LaneRunRecord> => {
    const laneDir = join(run.dir, "lanes", lane.id);
    mkdirSync(laneDir, { recursive: true });

    const worktreePath = join(run.dir, "worktrees", lane.id);
    mkdirSync(join(run.dir, "worktrees"), { recursive: true });

    const sessionDir = join(run.dir, "sessions", lane.id);
    mkdirSync(sessionDir, { recursive: true });

    const promptPath = join(laneDir, "lane-prompt.md");
    writeFileSync(promptPath, lanePrompt(lane, { ...editArgs, path: relPath }), "utf8");

    const patchPath = join(laneDir, "lane.patch");

    try {
      const wtAdd = await runCommand("git", ["worktree", "add", "--detach", worktreePath, headSha], {
        cwd: repoRoot,
        timeoutMs: 30000,
        signal: abortController.signal,
      });
      if (wtAdd.code !== 0) {
        return {
          lane_id: lane.id,
          status: "error",
          error: `Failed to create worktree: ${wtAdd.stderr || wtAdd.stdout}`,
        };
      }

      // Sync only the target file from main workspace into each lane baseline.
      // This avoids large/corrupt full-repo patch transfer issues in the prototype.
      const targetFilePath = join(worktreePath, relPath);
      if (existsSync(sourceTargetPath)) {
        mkdirSync(dirname(targetFilePath), { recursive: true });
        cpSync(sourceTargetPath, targetFilePath);
      }

      const beforeContent = existsSync(targetFilePath) ? readFileSync(targetFilePath, "utf8") : "";

      const start = Date.now();
      let laneHarnessUsed: "direct" | "pi_prompt" = requestedLaneHarness === "pi_prompt" ? "pi_prompt" : "direct";
      let directLatencyMs: number | undefined;
      let sessionPath: string | undefined;
      let parsed: ReturnType<typeof parseLaneSession> = {
        outputText: undefined,
        isError: false,
        totalTokens: undefined,
        editCallCount: 1,
        exactEditArgsMatch: true,
        laneDone: true,
      };
      let piRes: { stdout: string; stderr: string; code: number; killed: boolean; timedOut: boolean } = {
        stdout: "",
        stderr: "",
        code: 0,
        killed: false,
        timedOut: false,
      };

      if (laneHarnessUsed === "direct") {
        try {
          const direct = await runLaneDirect(lane, {
            cwd,
            loadedPath: loaded.path,
            worktreePath,
            editArgs: { path: relPath, oldText: editArgs.oldText, newText: editArgs.newText },
            signal: abortController.signal,
          });

          directLatencyMs = direct.latencyMs;
          piRes = {
            ...piRes,
            code: direct.code,
            timedOut: direct.timedOut,
          };

          parsed = {
            ...parsed,
            outputText: direct.outputText,
            isError: direct.isError,
          };
        } catch {
          // Direct harness failed unexpectedly (e.g. extension load/runtime mismatch).
          // Fall back to legacy pi prompt harness for compatibility.
          laneHarnessUsed = "pi_prompt";
        }
      }

      if (laneHarnessUsed === "pi_prompt") {
        const piArgs: string[] = [
          "-p",
          "--session-dir",
          sessionDir,
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
        ];

        // Keep lane panes human-readable by default.
        // Opt-in JSON event streaming with PI_AB_DEBUG_JSON=1 when needed.
        if (process.env.PI_AB_DEBUG_JSON === "1" && experiment.debug === true && laneSurfaces[laneIndex]) {
          piArgs.push("--mode", "json");
        }

        for (const ext of lane.extensions) {
          piArgs.push("-e", resolveConfiguredPath(ext, cwd, loaded.path));
        }

        piArgs.push(`@${promptPath}`);

        piRes = await runLanePi(piArgs, {
          worktreePath,
          timeoutMs,
          signal: abortController.signal,
          surface: laneSurfaces[laneIndex],
        });

        sessionPath = newestSessionFile(sessionDir);
        parsed = parseLaneSession(sessionPath, { path: relPath, oldText: editArgs.oldText, newText: editArgs.newText });
      }

      const elapsed = laneHarnessUsed === "direct" ? (directLatencyMs ?? Date.now() - start) : Date.now() - start;
      if (laneHarnessUsed === "direct" && elapsed > timeoutMs) {
        piRes.timedOut = true;
      }

      const afterContent = existsSync(targetFilePath) ? readFileSync(targetFilePath, "utf8") : "";
      // Always generate the lane patch from runtime before/after file snapshots.
      // This avoids HEAD/index drift producing patches that don't apply to the live workspace.
      const beforePath = join(laneDir, "target-before.txt");
      const afterPath = join(laneDir, "target-after.txt");
      writeFileSync(beforePath, beforeContent, "utf8");
      writeFileSync(afterPath, afterContent, "utf8");

      const noIndex = await runCommand("git", ["diff", "--no-index", "--binary", beforePath, afterPath], {
        cwd: worktreePath,
        timeoutMs: 10000,
      });
      const patchText = normalizeNoIndexPatchPaths(noIndex.stdout, relPath);

      writeFileSync(patchPath, patchText, "utf8");

      if (!experiment.debug) {
        await removeWorktree(repoRoot, worktreePath);
      }

      if (piRes.timedOut) {
        if (policy.on_lane_timeout === "abort_all") abortController.abort();
        return {
          lane_id: lane.id,
          status: "timeout",
          latency_ms: elapsed,
          error: `Lane timed out after ${timeoutMs}ms`,
          process_exit_code: piRes.code,
          output_text: parsed.outputText,
          total_tokens: parsed.totalTokens,
          patch_path: patchPath,
          patch_bytes: Buffer.byteLength(patchText, "utf8"),
          session_file: sessionPath,
          worktree_path: worktreePath,
          lane_harness_used: laneHarnessUsed,
        };
      }

      const patchBytes = Buffer.byteLength(patchText, "utf8");
      const protocolError =
        parsed.editCallCount !== 1 ||
        !parsed.exactEditArgsMatch ||
        !parsed.laneDone;

      const laneError = piRes.code !== 0 || parsed.isError === true || patchBytes === 0 || protocolError;
      if (laneError && policy.on_lane_crash === "abort_all") {
        abortController.abort();
      }

      const protocolErrorText =
        parsed.editCallCount !== 1
          ? `Lane protocol violation: expected exactly 1 edit tool call, got ${parsed.editCallCount}`
          : !parsed.exactEditArgsMatch
            ? "Lane protocol violation: edit args differed from EXACT_EDIT_ARGS_JSON"
            : !parsed.laneDone
              ? "Lane protocol violation: final assistant response was not exactly LANE_DONE"
              : undefined;

      const laneErrorText =
        protocolErrorText ??
        (parsed.isError === true
          ? parsed.outputText ?? "Lane tool call returned error"
          : patchBytes === 0
            ? "Lane produced no patch"
            : (piRes.stderr || piRes.stdout || "Lane execution failed"));

      return {
        lane_id: lane.id,
        status: laneError ? "error" : "success",
        latency_ms: elapsed,
        error: laneError ? laneErrorText : undefined,
        process_exit_code: piRes.code,
        output_text: parsed.outputText,
        total_tokens: parsed.totalTokens,
        patch_path: patchPath,
        patch_bytes: patchBytes,
        session_file: sessionPath,
        worktree_path: worktreePath,
        lane_harness_used: laneHarnessUsed,
      };
    } catch (err: any) {
      if (!experiment.debug) {
        try {
          await removeWorktree(repoRoot, worktreePath);
        } catch {}
      }
      return {
        lane_id: lane.id,
        status: "error",
        error: err?.message ?? String(err),
        patch_path: existsSync(patchPath) ? patchPath : undefined,
      };
    } finally {
      const surface = laneSurfaces[laneIndex];
      if (surface && !keepDebugPanes) {
        try {
          closeCmuxSurface(surface);
        } catch {
          try {
            const reboundSurface = findCmuxSurfaceByTitle(`AB Lane ${lane.id}`);
            if (reboundSurface) closeCmuxSurface(reboundSurface);
          } catch {}
        }
      }
    }
  });

  const results = await Promise.all(lanePromises);

  // Final sweep: close any orphaned AB lane panes that survived per-lane finally blocks.
  if (useCmuxDebug && !keepDebugPanes) {
    try {
      closeCmuxSurfacesByTitlePrefix("AB Lane ");
    } catch {}
  }

  return results;
}
