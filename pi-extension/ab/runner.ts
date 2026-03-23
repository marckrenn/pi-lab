import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEditTool } from "@mariozechner/pi-coding-agent";
import type { LoadedExperiment, LaneConfig, LaneRunRecord } from "./types.ts";
import { resolveConfiguredPath } from "./config.ts";
import type { RunContext } from "./storage.ts";
import { extractFirstJsonObject, runCommand, safeJsonParse } from "./utils.ts";
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
      arguments?: Record<string, unknown>;
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
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
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
  opts?: { includeDefaultEdit?: boolean },
): Promise<Map<string, DirectLaneTool>> {
  const toolRegistry = new Map<string, DirectLaneTool>();
  if (opts?.includeDefaultEdit !== false) {
    toolRegistry.set("edit", createEditTool(worktreePath) as unknown as DirectLaneTool);
  }

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

async function runLaneDirectFixedArgs(
  lane: LaneConfig,
  options: {
    cwd: string;
    loadedPath: string;
    worktreePath: string;
    targetTool: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  },
): Promise<{ outputText?: string; isError: boolean; errorText?: string; timedOut: boolean; code: number; latencyMs: number }> {
  return withLaneProcessCwd(options.worktreePath, async () => {
    const started = Date.now();
    const tools = await loadLaneToolsDirect(lane, options.cwd, options.loadedPath, options.worktreePath, {
      includeDefaultEdit: false,
    });
    const targetTool = tools.get(options.targetTool);
    if (!targetTool) {
      return {
        outputText: `Lane ${lane.id} does not provide tool '${options.targetTool}'`,
        isError: true,
        errorText: `Lane ${lane.id} does not provide tool '${options.targetTool}'`,
        timedOut: false,
        code: 0,
        latencyMs: Date.now() - started,
      };
    }

    try {
      const result = await targetTool.execute(
        `ab-lane-${lane.id}`,
        options.args,
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

function laneMultiCallPrompt(
  lane: LaneConfig,
  targetTool: string,
  args: { task: string; context?: string; constraints?: string },
): string {
  return [
    `You are lane ${lane.id} in an A/B experiment for tool '${targetTool}'.`,
    "You may call tools available in this lane to solve the user task.",
    "Lane APIs may differ from other lanes. Choose the correct API for THIS lane.",
    "You MUST call at least one lane-specific non-builtin tool before giving the final answer.",
    "At the end, respond with STRICT JSON only:",
    '{"status":"success|error","final_answer":"...","error":"...optional..."}',
    "",
    `USER_TASK: ${args.task}`,
    args.context ? `CONTEXT: ${args.context}` : "",
    args.constraints ? `CONSTRAINTS: ${args.constraints}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function laneSingleCallPrompt(
  lane: LaneConfig,
  targetTool: string,
  args: { task: string; context?: string; constraints?: string },
): string {
  return [
    `You are lane ${lane.id} in an A/B experiment for tool '${targetTool}'.`,
    `Call the target tool '${targetTool}' EXACTLY ONCE using this lane's available schema.`,
    "Do NOT call any other tools.",
    "After the tool call, respond with exactly: LANE_DONE",
    "",
    `USER_TASK: ${args.task}`,
    args.context ? `CONTEXT: ${args.context}` : "",
    args.constraints ? `CONSTRAINTS: ${args.constraints}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseMultiCallLaneSession(sessionFile: string | undefined): {
  outputText?: string;
  isError?: boolean;
  totalTokens?: number;
  statusHint?: "success" | "error";
  errorHint?: string;
  toolCallCount: number;
  customToolCallCount: number;
} {
  if (!sessionFile || !existsSync(sessionFile)) return { toolCallCount: 0, customToolCallCount: 0 };

  const lines = readFileSync(sessionFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let lastAssistant: SessionMessageEntry["message"] | undefined;
  const builtins = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  let sawToolError = false;
  const toolErrorHints: string[] = [];
  let toolCallCount = 0;
  let customToolCallCount = 0;

  for (const line of lines) {
    const parsed = safeJsonParse<SessionMessageEntry>(line);
    if (!parsed || parsed.type !== "message") continue;

    if (parsed.message.role === "toolResult") {
      if (parsed.message.isError === true) {
        sawToolError = true;
        const hint = (parsed.message.content ?? [])
          .filter((b: any) => b?.type === "text" && typeof b?.text === "string")
          .map((b: any) => b.text.trim())
          .filter(Boolean)
          .join("\n")
          .trim();
        if (hint) toolErrorHints.push(hint);
      }
    }

    if (parsed.message.role === "assistant") {
      lastAssistant = parsed.message;
      for (const block of parsed.message.content ?? []) {
        if (block.type === "toolCall") {
          toolCallCount += 1;
          if (typeof block.name === "string" && !builtins.has(block.name)) {
            customToolCallCount += 1;
          }
        }
      }
    }
  }

  const assistantText = (lastAssistant?.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const parsedJson =
    safeJsonParse<{ status?: string; final_answer?: string; error?: string }>(assistantText) ??
    (extractFirstJsonObject(assistantText) as { status?: string; final_answer?: string; error?: string } | null);

  const statusRaw = parsedJson?.status?.toLowerCase();
  const statusHint = statusRaw === "success" || statusRaw === "error" ? (statusRaw as "success" | "error") : undefined;
  const finalAnswer = typeof parsedJson?.final_answer === "string" ? parsedJson.final_answer.trim() : "";
  const explicitErrorHint = typeof parsedJson?.error === "string" ? parsedJson.error.trim() : undefined;
  const strictJsonViolation = !parsedJson || !statusHint;
  const missingFinalAnswer = statusHint === "success" && finalAnswer.length === 0;
  const protocolErrorHint =
    strictJsonViolation
      ? "Lane protocol violation: final assistant response was not strict JSON with status='success|error'."
      : missingFinalAnswer
        ? "Lane protocol violation: status=success requires non-empty final_answer."
        : toolCallCount === 0
          ? "Lane protocol violation: expected at least one tool call in lane_multi_call."
          : customToolCallCount === 0
            ? "Lane protocol violation: expected at least one non-builtin (lane-specific) tool call in lane_multi_call."
            : undefined;

  return {
    outputText: finalAnswer || assistantText || undefined,
    isError:
      statusHint === "error" ||
      strictJsonViolation ||
      missingFinalAnswer ||
      toolCallCount === 0 ||
      customToolCallCount === 0 ||
      sawToolError,
    totalTokens: lastAssistant?.usage?.totalTokens,
    statusHint,
    errorHint: explicitErrorHint ?? toolErrorHints[0] ?? protocolErrorHint,
    toolCallCount,
    customToolCallCount,
  };
}

function parseSingleCallLaneSession(
  sessionFile: string | undefined,
  targetTool: string,
): {
  outputText?: string;
  isError?: boolean;
  totalTokens?: number;
  targetToolCallCount: number;
  totalToolCallCount: number;
  laneDone: boolean;
  errorHint?: string;
} {
  if (!sessionFile || !existsSync(sessionFile)) {
    return { targetToolCallCount: 0, totalToolCallCount: 0, laneDone: false };
  }

  const lines = readFileSync(sessionFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let lastAssistant: SessionMessageEntry["message"] | undefined;
  let lastTargetResult: SessionMessageEntry["message"] | undefined;
  let targetToolCallCount = 0;
  let totalToolCallCount = 0;
  let sawTargetToolError = false;
  const targetToolErrors: string[] = [];

  for (const line of lines) {
    const parsed = safeJsonParse<SessionMessageEntry>(line);
    if (!parsed || parsed.type !== "message") continue;

    if (parsed.message.role === "assistant") {
      lastAssistant = parsed.message;
      for (const block of parsed.message.content ?? []) {
        if (block.type !== "toolCall") continue;
        totalToolCallCount += 1;
        if (block.name === targetTool) targetToolCallCount += 1;
      }
    }

    if (parsed.message.role === "toolResult" && parsed.message.toolName === targetTool) {
      lastTargetResult = parsed.message;
      if (parsed.message.isError === true) {
        sawTargetToolError = true;
        const err = (parsed.message.content ?? [])
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text?.trim())
          .filter(Boolean)
          .join("\n")
          .trim();
        if (err) targetToolErrors.push(err);
      }
    }
  }

  const outputText = (lastTargetResult?.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const assistantText = (lastAssistant?.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const protocolErrorHint =
    targetToolCallCount !== 1
      ? `Lane protocol violation: expected exactly 1 '${targetTool}' call, got ${targetToolCallCount}`
      : totalToolCallCount !== 1
        ? `Lane protocol violation: expected exactly 1 total tool call, got ${totalToolCallCount}`
        : assistantText !== "LANE_DONE"
          ? "Lane protocol violation: final assistant response was not exactly LANE_DONE"
          : undefined;

  return {
    outputText: outputText || undefined,
    isError: sawTargetToolError || !!protocolErrorHint,
    totalTokens: lastAssistant?.usage?.totalTokens,
    targetToolCallCount,
    totalToolCallCount,
    laneDone: assistantText === "LANE_DONE",
    errorHint: targetToolErrors[0] ?? protocolErrorHint,
  };
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeJsonValue(v));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, normalizeJsonValue(v)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

function schemaObjectKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const props = (schema as any).properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props).sort((a, b) => a.localeCompare(b));
}

function hasSameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function computeCapabilityFairnessTelemetry(capabilities: LaneCapabilityInfo[]): CapabilityFairnessTelemetry {
  const keysByLane = capabilities.map((cap) => ({
    lane_id: cap.lane_id,
    has_target_tool: cap.has_target_tool,
    parameter_keys: [...cap.parameter_keys].sort((a, b) => a.localeCompare(b)),
    inspection_error: cap.inspection_error,
  }));

  const withTool = keysByLane.filter((cap) => cap.has_target_tool);
  const union = new Set<string>();
  for (const lane of withTool) {
    for (const key of lane.parameter_keys) union.add(key);
  }

  const intersection = new Set<string>(withTool[0]?.parameter_keys ?? []);
  for (const lane of withTool.slice(1)) {
    for (const key of [...intersection]) {
      if (!lane.parameter_keys.includes(key)) intersection.delete(key);
    }
  }

  const allHaveTool = keysByLane.length > 0 && keysByLane.every((cap) => cap.has_target_tool);
  const identicalKeySets =
    withTool.length <= 1 || withTool.every((cap) => hasSameKeys(cap.parameter_keys, withTool[0].parameter_keys));

  return {
    capability_policy: allHaveTool && identicalKeySets ? "intersection" : "best_effort",
    capability_intersection_keys: [...intersection].sort((a, b) => a.localeCompare(b)),
    capability_union_keys: [...union].sort((a, b) => a.localeCompare(b)),
    lane_capabilities: keysByLane,
  };
}

function laneFixedArgsPrompt(
  lane: LaneConfig,
  targetTool: string,
  args: Record<string, unknown>,
): string {
  const exactArgs = JSON.stringify(args);

  return [
    `You are lane ${lane.id} in an A/B experiment for tool '${targetTool}'.`,
    `Execute EXACTLY ONE ${targetTool} tool call.`,
    "Use the EXACT JSON arguments below without modifications.",
    "Do not call any other mutating tools.",
    "After the tool call, respond with: LANE_DONE",
    "",
    `EXACT_TOOL_ARGS_JSON: ${exactArgs}`,
  ].join("\n");
}

function parseFixedArgsLaneSession(
  sessionFile: string | undefined,
  targetTool: string,
  expectedArgs: Record<string, unknown>,
): {
  outputText?: string;
  isError?: boolean;
  totalTokens?: number;
  toolCallCount: number;
  exactArgsMatch: boolean;
  laneDone: boolean;
} {
  if (!sessionFile || !existsSync(sessionFile)) {
    return { toolCallCount: 0, exactArgsMatch: false, laneDone: false };
  }

  const lines = readFileSync(sessionFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let lastTargetToolResult: SessionMessageEntry["message"] | undefined;
  let lastAssistant: SessionMessageEntry["message"] | undefined;
  let toolCallCount = 0;
  let exactArgsMatch = false;
  const expectedStable = stableJson(expectedArgs);

  for (const line of lines) {
    const parsed = safeJsonParse<SessionMessageEntry>(line);
    if (!parsed || parsed.type !== "message") continue;

    if (parsed.message.role === "assistant") {
      lastAssistant = parsed.message;
      for (const block of parsed.message.content ?? []) {
        if (block.type !== "toolCall" || block.name !== targetTool) continue;
        toolCallCount += 1;
        const actualStable = stableJson(block.arguments ?? {});
        if (actualStable === expectedStable) {
          exactArgsMatch = true;
        }
      }
    }

    if (parsed.message.role === "toolResult" && parsed.message.toolName === targetTool) {
      lastTargetToolResult = parsed.message;
    }
  }

  const outputText = (lastTargetToolResult?.content ?? [])
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
    isError: lastTargetToolResult?.isError,
    totalTokens: lastAssistant?.usage?.totalTokens,
    toolCallCount,
    exactArgsMatch,
    laneDone: assistantText === "LANE_DONE",
  };
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

async function createWorktreePatch(worktreePath: string, laneDir: string): Promise<{ patchPath: string; patchText: string; patchBytes: number }> {
  await runCommand("git", ["add", "-N", "."], {
    cwd: worktreePath,
    timeoutMs: 10000,
  });

  const patch = await runCommand("git", ["diff", "--binary"], {
    cwd: worktreePath,
    timeoutMs: 10000,
  });

  const patchText = patch.stdout;
  const patchPath = join(laneDir, "lane.patch");
  writeFileSync(patchPath, patchText, "utf8");

  return {
    patchPath,
    patchText,
    patchBytes: Buffer.byteLength(patchText, "utf8"),
  };
}

async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await runCommand("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
    timeoutMs: 15000,
  });
}

async function syncWorkspaceDeltaToWorktree(repoRoot: string, worktreePath: string, signal?: AbortSignal): Promise<void> {
  const status = await runCommand("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    timeoutMs: 20000,
    signal,
  });
  if (status.code !== 0) return;

  const lines = status.stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    if (line.length < 4) continue;
    const rawPath = line.slice(3);
    const relPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() ?? rawPath : rawPath;
    const src = join(repoRoot, relPath);
    const dst = join(worktreePath, relPath);

    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      const sourceStat = statSync(src);
      if (sourceStat.isDirectory()) {
        cpSync(src, dst, { recursive: true });
      } else {
        cpSync(src, dst);
      }
    } else if (existsSync(dst)) {
      rmSync(dst, { force: true, recursive: true });
    }
  }
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

export interface LaneProgressItem {
  lane_id: string;
  status: "pending" | "running" | "success" | "error" | "timeout";
  elapsed_ms?: number;
  error?: string;
}

export interface LaneProgressSnapshot {
  run_id: string;
  lanes: LaneProgressItem[];
}

export interface LaneCapabilityInfo {
  lane_id: string;
  has_target_tool: boolean;
  parameter_keys: string[];
  inspection_error?: string;
}

export interface CapabilityFairnessTelemetry {
  capability_policy: "intersection" | "best_effort";
  capability_intersection_keys: string[];
  capability_union_keys: string[];
  lane_capabilities: LaneCapabilityInfo[];
}

export async function runExperimentLanes(
  loaded: LoadedExperiment,
  run: RunContext,
  cwd: string,
  sessionFile: string | null,
  editArgs: { path: string; oldText: string; newText: string },
  signal?: AbortSignal,
  onProgress?: (snapshot: LaneProgressSnapshot) => void,
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

  const laneProgress = new Map<string, { status: LaneProgressItem["status"]; startedAt?: number; elapsedMs?: number; error?: string }>();
  for (const lane of experiment.lanes) {
    laneProgress.set(lane.id, { status: "pending" });
  }

  const emitProgress = () => {
    if (!onProgress) return;
    const now = Date.now();
    onProgress({
      run_id: run.runId,
      lanes: experiment.lanes.map((lane) => {
        const entry = laneProgress.get(lane.id) ?? { status: "pending" as const };
        const elapsed_ms =
          entry.status === "running"
            ? (entry.startedAt ? now - entry.startedAt : entry.elapsedMs)
            : entry.elapsedMs;
        return {
          lane_id: lane.id,
          status: entry.status,
          elapsed_ms,
          error: entry.error,
        };
      }),
    });
  };

  const setLaneProgress = (
    laneId: string,
    status: LaneProgressItem["status"],
    opts?: { elapsedMs?: number; error?: string },
  ) => {
    const current = laneProgress.get(laneId) ?? { status: "pending" as const };
    laneProgress.set(laneId, {
      status,
      startedAt: status === "running" ? Date.now() : current.startedAt,
      elapsedMs: opts?.elapsedMs ?? (status === "running" ? current.elapsedMs : current.elapsedMs),
      error: opts?.error,
    });
    emitProgress();
  };

  emitProgress();
  const progressTimer = onProgress ? setInterval(emitProgress, 500) : undefined;

  const lanePromises = experiment.lanes.map(async (lane, laneIndex): Promise<LaneRunRecord> => {
    setLaneProgress(lane.id, "running");

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
      const beforePath = join(laneDir, "target-before.md");
      const afterPath = join(laneDir, "target-after.md");
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

  const trackedLanePromises = lanePromises.map(async (promise) => {
    const record = await promise;
    const status: LaneProgressItem["status"] =
      record.status === "success" ? "success" : record.status === "timeout" ? "timeout" : "error";
    setLaneProgress(record.lane_id, status, { elapsedMs: record.latency_ms, error: record.error });
    return record;
  });

  try {
    const results = await Promise.all(trackedLanePromises);

    // Final sweep: close any orphaned AB lane panes that survived per-lane finally blocks.
    if (useCmuxDebug && !keepDebugPanes) {
      try {
        closeCmuxSurfacesByTitlePrefix("AB Lane ");
      } catch {}
    }

    return results;
  } finally {
    if (progressTimer) {
      clearInterval(progressTimer);
      emitProgress();
    }
  }
}

export async function runExperimentLanesFixedArgsTool(
  loaded: LoadedExperiment,
  run: RunContext,
  cwd: string,
  targetTool: string,
  toolArgs: Record<string, unknown>,
  signal?: AbortSignal,
  onProgress?: (snapshot: LaneProgressSnapshot) => void,
): Promise<{ records: LaneRunRecord[]; fairness: CapabilityFairnessTelemetry }> {
  const experiment = loaded.experiment;
  const timeoutMs = experiment.timeout_ms ?? 15000;
  const repoRoot = await getRepoRoot(cwd, signal);
  const headSha = await getHeadSha(repoRoot, signal);

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

  const laneProgress = new Map<string, { status: LaneProgressItem["status"]; startedAt?: number; elapsedMs?: number; error?: string }>();
  for (const lane of experiment.lanes) laneProgress.set(lane.id, { status: "pending" });

  const emitProgress = () => {
    if (!onProgress) return;
    const now = Date.now();
    onProgress({
      run_id: run.runId,
      lanes: experiment.lanes.map((lane) => {
        const entry = laneProgress.get(lane.id) ?? { status: "pending" as const };
        const elapsed_ms =
          entry.status === "running"
            ? (entry.startedAt ? now - entry.startedAt : entry.elapsedMs)
            : entry.elapsedMs;
        return {
          lane_id: lane.id,
          status: entry.status,
          elapsed_ms,
          error: entry.error,
        };
      }),
    });
  };

  const setLaneProgress = (
    laneId: string,
    status: LaneProgressItem["status"],
    opts?: { elapsedMs?: number; error?: string },
  ) => {
    const current = laneProgress.get(laneId) ?? { status: "pending" as const };
    laneProgress.set(laneId, {
      status,
      startedAt: status === "running" ? Date.now() : current.startedAt,
      elapsedMs: opts?.elapsedMs ?? current.elapsedMs,
      error: opts?.error,
    });
    emitProgress();
  };

  emitProgress();
  const progressTimer = onProgress ? setInterval(emitProgress, 500) : undefined;

  const laneCapabilities = new Map<string, LaneCapabilityInfo>();

  const lanePromises = experiment.lanes.map(async (lane, laneIndex): Promise<LaneRunRecord> => {
    setLaneProgress(lane.id, "running");

    const laneDir = join(run.dir, "lanes", lane.id);
    mkdirSync(laneDir, { recursive: true });

    const worktreePath = join(run.dir, "worktrees", lane.id);
    mkdirSync(join(run.dir, "worktrees"), { recursive: true });

    const sessionDir = join(run.dir, "sessions", lane.id);
    mkdirSync(sessionDir, { recursive: true });

    const promptPath = join(laneDir, "lane-prompt.md");
    writeFileSync(promptPath, laneFixedArgsPrompt(lane, targetTool, toolArgs), "utf8");

    try {
      const wtAdd = await runCommand("git", ["worktree", "add", "--detach", worktreePath, headSha], {
        cwd: repoRoot,
        timeoutMs: 30000,
        signal: abortController.signal,
      });
      if (wtAdd.code !== 0) {
        laneCapabilities.set(lane.id, {
          lane_id: lane.id,
          has_target_tool: false,
          parameter_keys: [],
          inspection_error: `Failed to create worktree: ${wtAdd.stderr || wtAdd.stdout}`,
        });
        return {
          lane_id: lane.id,
          status: "error",
          error: `Failed to create worktree: ${wtAdd.stderr || wtAdd.stdout}`,
        };
      }

      await syncWorkspaceDeltaToWorktree(repoRoot, worktreePath, abortController.signal);

      let laneHarnessUsed: "direct" | "pi_prompt" = requestedLaneHarness === "pi_prompt" ? "pi_prompt" : "direct";

      try {
        const loadedTools = await loadLaneToolsDirect(lane, cwd, loaded.path, worktreePath, {
          includeDefaultEdit: false,
        });
        const laneTool = loadedTools.get(targetTool);
        laneCapabilities.set(lane.id, {
          lane_id: lane.id,
          has_target_tool: !!laneTool,
          parameter_keys: schemaObjectKeys(laneTool?.parameters),
          inspection_error: laneTool ? undefined : `Lane ${lane.id} does not provide tool '${targetTool}'`,
        });
      } catch (inspectErr: any) {
        laneCapabilities.set(lane.id, {
          lane_id: lane.id,
          has_target_tool: false,
          parameter_keys: [],
          inspection_error: inspectErr?.message ?? String(inspectErr),
        });
      }

      const start = Date.now();
      let directLatencyMs: number | undefined;
      let sessionPath: string | undefined;
      let parsed: ReturnType<typeof parseFixedArgsLaneSession> = {
        outputText: undefined,
        isError: false,
        totalTokens: undefined,
        toolCallCount: 1,
        exactArgsMatch: true,
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
          const direct = await runLaneDirectFixedArgs(lane, {
            cwd,
            loadedPath: loaded.path,
            worktreePath,
            targetTool,
            args: toolArgs,
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
        parsed = parseFixedArgsLaneSession(sessionPath, targetTool, toolArgs);
      }

      const elapsed = laneHarnessUsed === "direct" ? (directLatencyMs ?? Date.now() - start) : Date.now() - start;
      if (laneHarnessUsed === "direct" && elapsed > timeoutMs) {
        piRes.timedOut = true;
      }

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
          session_file: sessionPath,
          worktree_path: worktreePath,
          lane_harness_used: laneHarnessUsed,
        };
      }

      const protocolError =
        laneHarnessUsed === "pi_prompt" &&
        (parsed.toolCallCount !== 1 || !parsed.exactArgsMatch || !parsed.laneDone);

      const protocolErrorText =
        parsed.toolCallCount !== 1
          ? `Lane protocol violation: expected exactly 1 ${targetTool} tool call, got ${parsed.toolCallCount}`
          : !parsed.exactArgsMatch
            ? "Lane protocol violation: tool args differed from EXACT_TOOL_ARGS_JSON"
            : !parsed.laneDone
              ? "Lane protocol violation: final assistant response was not exactly LANE_DONE"
              : undefined;

      const laneError = piRes.code !== 0 || parsed.isError === true || protocolError;
      if (laneError && policy.on_lane_crash === "abort_all") abortController.abort();

      const laneErrorText =
        protocolErrorText ??
        (parsed.isError === true
          ? parsed.outputText ?? `Lane ${lane.id} tool call returned error`
          : (piRes.stderr || piRes.stdout || `Lane ${lane.id} execution failed`));

      return {
        lane_id: lane.id,
        status: laneError ? "error" : "success",
        latency_ms: elapsed,
        error: laneError ? laneErrorText : undefined,
        process_exit_code: piRes.code,
        output_text: parsed.outputText,
        total_tokens: parsed.totalTokens,
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
      if (!laneCapabilities.has(lane.id)) {
        laneCapabilities.set(lane.id, {
          lane_id: lane.id,
          has_target_tool: false,
          parameter_keys: [],
          inspection_error: err?.message ?? String(err),
        });
      }
      return {
        lane_id: lane.id,
        status: "error",
        error: err?.message ?? String(err),
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

  const trackedLanePromises = lanePromises.map(async (promise) => {
    const record = await promise;
    const status: LaneProgressItem["status"] =
      record.status === "success" ? "success" : record.status === "timeout" ? "timeout" : "error";
    setLaneProgress(record.lane_id, status, { elapsedMs: record.latency_ms, error: record.error });
    return record;
  });

  try {
    const records = await Promise.all(trackedLanePromises);
    if (useCmuxDebug && !keepDebugPanes) {
      try {
        closeCmuxSurfacesByTitlePrefix("AB Lane ");
      } catch {}
    }

    const fairness = computeCapabilityFairnessTelemetry(
      experiment.lanes.map((lane) =>
        laneCapabilities.get(lane.id) ?? {
          lane_id: lane.id,
          has_target_tool: false,
          parameter_keys: [],
          inspection_error: "Capability inspection not collected",
        },
      ),
    );

    return { records, fairness };
  } finally {
    if (progressTimer) {
      clearInterval(progressTimer);
      emitProgress();
    }
  }
}

export async function runExperimentLanesSingleCall(
  loaded: LoadedExperiment,
  run: RunContext,
  cwd: string,
  targetTool: string,
  flowArgs: { task: string; context?: string; constraints?: string },
  signal?: AbortSignal,
  onProgress?: (snapshot: LaneProgressSnapshot) => void,
): Promise<{ records: LaneRunRecord[]; fairness: CapabilityFairnessTelemetry }> {
  const experiment = loaded.experiment;
  const timeoutMs = experiment.timeout_ms ?? 15000;
  const repoRoot = await getRepoRoot(cwd, signal);
  const headSha = await getHeadSha(repoRoot, signal);

  const policy = experiment.failure_policy ?? {};
  const abortController = new AbortController();
  signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const keepDebugPanes = process.env.PI_AB_KEEP_PANES === "1";
  const debugUiMode = (process.env.PI_AB_DEBUG_UI ?? experiment.debug_ui ?? "none").toLowerCase();
  const useCmuxDebug = experiment.debug === true && debugUiMode !== "none" && isCmuxAvailable();

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
      laneSurfaces.length = 0;
    }
  }

  const laneProgress = new Map<string, { status: LaneProgressItem["status"]; startedAt?: number; elapsedMs?: number; error?: string }>();
  for (const lane of experiment.lanes) laneProgress.set(lane.id, { status: "pending" });

  const emitProgress = () => {
    if (!onProgress) return;
    const now = Date.now();
    onProgress({
      run_id: run.runId,
      lanes: experiment.lanes.map((lane) => {
        const entry = laneProgress.get(lane.id) ?? { status: "pending" as const };
        return {
          lane_id: lane.id,
          status: entry.status,
          elapsed_ms: entry.status === "running" ? (entry.startedAt ? now - entry.startedAt : entry.elapsedMs) : entry.elapsedMs,
          error: entry.error,
        };
      }),
    });
  };

  const setLaneProgress = (laneId: string, status: LaneProgressItem["status"], opts?: { elapsedMs?: number; error?: string }) => {
    const current = laneProgress.get(laneId) ?? { status: "pending" as const };
    laneProgress.set(laneId, {
      status,
      startedAt: status === "running" ? Date.now() : current.startedAt,
      elapsedMs: opts?.elapsedMs ?? current.elapsedMs,
      error: opts?.error,
    });
    emitProgress();
  };

  emitProgress();
  const progressTimer = onProgress ? setInterval(emitProgress, 500) : undefined;

  const laneCapabilities = new Map<string, LaneCapabilityInfo>();

  const lanePromises = experiment.lanes.map(async (lane, laneIndex): Promise<LaneRunRecord> => {
    setLaneProgress(lane.id, "running");

    const laneDir = join(run.dir, "lanes", lane.id);
    mkdirSync(laneDir, { recursive: true });

    const worktreePath = join(run.dir, "worktrees", lane.id);
    mkdirSync(join(run.dir, "worktrees"), { recursive: true });

    const sessionDir = join(run.dir, "sessions", lane.id);
    mkdirSync(sessionDir, { recursive: true });

    const promptPath = join(laneDir, "lane-prompt.md");
    writeFileSync(promptPath, laneSingleCallPrompt(lane, targetTool, flowArgs), "utf8");

    try {
      const wtAdd = await runCommand("git", ["worktree", "add", "--detach", worktreePath, headSha], {
        cwd: repoRoot,
        timeoutMs: 30000,
        signal: abortController.signal,
      });
      if (wtAdd.code !== 0) {
        laneCapabilities.set(lane.id, {
          lane_id: lane.id,
          has_target_tool: false,
          parameter_keys: [],
          inspection_error: `Failed to create worktree: ${wtAdd.stderr || wtAdd.stdout}`,
        });
        return {
          lane_id: lane.id,
          status: "error",
          error: `Failed to create worktree: ${wtAdd.stderr || wtAdd.stdout}`,
          lane_harness_used: "pi_prompt",
        };
      }

      await syncWorkspaceDeltaToWorktree(repoRoot, worktreePath, abortController.signal);

      try {
        const loadedTools = await loadLaneToolsDirect(lane, cwd, loaded.path, worktreePath, { includeDefaultEdit: false });
        const laneTool = loadedTools.get(targetTool);
        laneCapabilities.set(lane.id, {
          lane_id: lane.id,
          has_target_tool: !!laneTool,
          parameter_keys: schemaObjectKeys(laneTool?.parameters),
          inspection_error: laneTool ? undefined : `Lane ${lane.id} does not provide tool '${targetTool}'`,
        });
      } catch (inspectErr: any) {
        laneCapabilities.set(lane.id, {
          lane_id: lane.id,
          has_target_tool: false,
          parameter_keys: [],
          inspection_error: inspectErr?.message ?? String(inspectErr),
        });
      }

      const piArgs: string[] = [
        "-p",
        "--session-dir",
        sessionDir,
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
      ];

      if (process.env.PI_AB_DEBUG_JSON === "1" && experiment.debug === true && laneSurfaces[laneIndex]) {
        piArgs.push("--mode", "json");
      }

      for (const ext of lane.extensions) {
        piArgs.push("-e", resolveConfiguredPath(ext, cwd, loaded.path));
      }

      piArgs.push(`@${promptPath}`);

      const start = Date.now();
      const piRes = await runLanePi(piArgs, {
        worktreePath,
        timeoutMs,
        signal: abortController.signal,
        surface: laneSurfaces[laneIndex],
      });
      const elapsed = Date.now() - start;

      const sessionPath = newestSessionFile(sessionDir);
      const parsed = parseSingleCallLaneSession(sessionPath, targetTool);
      const patch = await createWorktreePatch(worktreePath, laneDir);

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
          patch_path: patch.patchPath,
          patch_bytes: patch.patchBytes,
          session_file: sessionPath,
          worktree_path: worktreePath,
          lane_harness_used: "pi_prompt",
        };
      }

      const laneError = piRes.code !== 0 || parsed.isError === true;
      if (laneError && policy.on_lane_crash === "abort_all") abortController.abort();

      const laneErrorText =
        parsed.errorHint ??
        (parsed.isError === true
          ? parsed.outputText ?? "Lane tool call returned error"
          : (piRes.stderr || piRes.stdout || "Lane execution failed"));

      return {
        lane_id: lane.id,
        status: laneError ? "error" : "success",
        latency_ms: elapsed,
        error: laneError ? laneErrorText : undefined,
        process_exit_code: piRes.code,
        output_text: parsed.outputText,
        total_tokens: parsed.totalTokens,
        patch_path: patch.patchPath,
        patch_bytes: patch.patchBytes,
        session_file: sessionPath,
        worktree_path: worktreePath,
        lane_harness_used: "pi_prompt",
      };
    } catch (err: any) {
      if (!experiment.debug) {
        try {
          await removeWorktree(repoRoot, worktreePath);
        } catch {}
      }
      if (!laneCapabilities.has(lane.id)) {
        laneCapabilities.set(lane.id, {
          lane_id: lane.id,
          has_target_tool: false,
          parameter_keys: [],
          inspection_error: err?.message ?? String(err),
        });
      }
      return {
        lane_id: lane.id,
        status: "error",
        error: err?.message ?? String(err),
        lane_harness_used: "pi_prompt",
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

  const trackedLanePromises = lanePromises.map(async (promise) => {
    const record = await promise;
    const status: LaneProgressItem["status"] =
      record.status === "success" ? "success" : record.status === "timeout" ? "timeout" : "error";
    setLaneProgress(record.lane_id, status, { elapsedMs: record.latency_ms, error: record.error });
    return record;
  });

  try {
    const records = await Promise.all(trackedLanePromises);
    if (useCmuxDebug && !keepDebugPanes) {
      try {
        closeCmuxSurfacesByTitlePrefix("AB Lane ");
      } catch {}
    }

    const fairness = computeCapabilityFairnessTelemetry(
      experiment.lanes.map((lane) =>
        laneCapabilities.get(lane.id) ?? {
          lane_id: lane.id,
          has_target_tool: false,
          parameter_keys: [],
          inspection_error: "Capability inspection not collected",
        },
      ),
    );

    return { records, fairness };
  } finally {
    if (progressTimer) {
      clearInterval(progressTimer);
      emitProgress();
    }
  }
}

export async function runExperimentLanesMultiCall(
  loaded: LoadedExperiment,
  run: RunContext,
  cwd: string,
  targetTool: string,
  flowArgs: { task: string; context?: string; constraints?: string },
  signal?: AbortSignal,
  onProgress?: (snapshot: LaneProgressSnapshot) => void,
): Promise<LaneRunRecord[]> {
  const experiment = loaded.experiment;
  const timeoutMs = experiment.timeout_ms ?? 15000;
  const repoRoot = await getRepoRoot(cwd, signal);
  const headSha = await getHeadSha(repoRoot, signal);

  const policy = experiment.failure_policy ?? {};
  const abortController = new AbortController();
  signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const keepDebugPanes = process.env.PI_AB_KEEP_PANES === "1";
  const debugUiMode = (process.env.PI_AB_DEBUG_UI ?? experiment.debug_ui ?? "none").toLowerCase();
  const useCmuxDebug = experiment.debug === true && debugUiMode !== "none" && isCmuxAvailable();

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
      laneSurfaces.length = 0;
    }
  }

  const laneProgress = new Map<string, { status: LaneProgressItem["status"]; startedAt?: number; elapsedMs?: number; error?: string }>();
  for (const lane of experiment.lanes) laneProgress.set(lane.id, { status: "pending" });

  const emitProgress = () => {
    if (!onProgress) return;
    const now = Date.now();
    onProgress({
      run_id: run.runId,
      lanes: experiment.lanes.map((lane) => {
        const entry = laneProgress.get(lane.id) ?? { status: "pending" as const };
        return {
          lane_id: lane.id,
          status: entry.status,
          elapsed_ms: entry.status === "running" ? (entry.startedAt ? now - entry.startedAt : entry.elapsedMs) : entry.elapsedMs,
          error: entry.error,
        };
      }),
    });
  };

  const setLaneProgress = (laneId: string, status: LaneProgressItem["status"], opts?: { elapsedMs?: number; error?: string }) => {
    const current = laneProgress.get(laneId) ?? { status: "pending" as const };
    laneProgress.set(laneId, {
      status,
      startedAt: status === "running" ? Date.now() : current.startedAt,
      elapsedMs: opts?.elapsedMs ?? current.elapsedMs,
      error: opts?.error,
    });
    emitProgress();
  };

  emitProgress();
  const progressTimer = onProgress ? setInterval(emitProgress, 500) : undefined;

  const lanePromises = experiment.lanes.map(async (lane, laneIndex): Promise<LaneRunRecord> => {
    setLaneProgress(lane.id, "running");

    const laneDir = join(run.dir, "lanes", lane.id);
    mkdirSync(laneDir, { recursive: true });

    const worktreePath = join(run.dir, "worktrees", lane.id);
    mkdirSync(join(run.dir, "worktrees"), { recursive: true });

    const sessionDir = join(run.dir, "sessions", lane.id);
    mkdirSync(sessionDir, { recursive: true });

    const promptPath = join(laneDir, "lane-prompt.md");
    writeFileSync(promptPath, laneMultiCallPrompt(lane, targetTool, flowArgs), "utf8");

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
          lane_harness_used: "pi_prompt",
        };
      }

      await syncWorkspaceDeltaToWorktree(repoRoot, worktreePath, abortController.signal);

      const piArgs: string[] = [
        "-p",
        "--session-dir",
        sessionDir,
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
      ];

      if (process.env.PI_AB_DEBUG_JSON === "1" && experiment.debug === true && laneSurfaces[laneIndex]) {
        piArgs.push("--mode", "json");
      }

      for (const ext of lane.extensions) {
        piArgs.push("-e", resolveConfiguredPath(ext, cwd, loaded.path));
      }

      piArgs.push(`@${promptPath}`);

      const start = Date.now();
      const piRes = await runLanePi(piArgs, {
        worktreePath,
        timeoutMs,
        signal: abortController.signal,
        surface: laneSurfaces[laneIndex],
      });
      const elapsed = Date.now() - start;

      const sessionPath = newestSessionFile(sessionDir);
      const parsed = parseMultiCallLaneSession(sessionPath);

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
          session_file: sessionPath,
          worktree_path: worktreePath,
          lane_harness_used: "pi_prompt",
        };
      }

      const laneError = piRes.code !== 0 || parsed.isError === true;
      if (laneError && policy.on_lane_crash === "abort_all") abortController.abort();

      const laneErrorText =
        parsed.errorHint ??
        (parsed.isError === true
          ? parsed.outputText ?? "Lane tool call returned error"
          : (piRes.stderr || piRes.stdout || "Lane execution failed"));

      return {
        lane_id: lane.id,
        status: laneError ? "error" : "success",
        latency_ms: elapsed,
        error: laneError ? laneErrorText : undefined,
        process_exit_code: piRes.code,
        output_text: parsed.outputText,
        total_tokens: parsed.totalTokens,
        session_file: sessionPath,
        worktree_path: worktreePath,
        lane_harness_used: "pi_prompt",
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
        lane_harness_used: "pi_prompt",
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

  const trackedLanePromises = lanePromises.map(async (promise) => {
    const record = await promise;
    const status: LaneProgressItem["status"] =
      record.status === "success" ? "success" : record.status === "timeout" ? "timeout" : "error";
    setLaneProgress(record.lane_id, status, { elapsedMs: record.latency_ms, error: record.error });
    return record;
  });

  try {
    const results = await Promise.all(trackedLanePromises);
    if (useCmuxDebug && !keepDebugPanes) {
      try {
        closeCmuxSurfacesByTitlePrefix("AB Lane ");
      } catch {}
    }
    return results;
  } finally {
    if (progressTimer) {
      clearInterval(progressTimer);
      emitProgress();
    }
  }
}

