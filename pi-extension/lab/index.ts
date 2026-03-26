import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  getSettingsListTheme,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  SettingsList,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type SettingItem,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getBaselineLaneId } from "./selection.ts";
import {
  canonicalExecutionStrategy,
  executionStrategyOf,
  formatExperimentSummary,
  getGlobalLabDir,
  getProjectLabDir,
  loadExperiments,
  selectExperimentForEdit,
  selectExperimentForTool,
  setExperimentEnabled,
  toolNameOf,
  winnerModeOf,
} from "./config.ts";
import { createRunContext, pruneEmptyRunScaffolding, writeLaneRecords, writeRunManifest } from "./storage.ts";
import {
  applyPatchToMain,
  detectGitRepository,
  runBaselineEditFallbackNoGit,
  runBaselineFixedArgsFallbackNoGit,
  runBaselineMultiCallFallbackNoGit,
  runBaselineSingleCallFallbackNoGit,
  runExperimentLanes,
  runExperimentLanesFixedArgsTool,
  runExperimentLanesMultiCall,
  runExperimentLanesSingleCall,
  type CapabilityFairnessTelemetry,
  type LaneProgressSnapshot,
} from "./runner.ts";
import { runAbGcCommand } from "./gc.ts";
import { defaultPolicy, laneById, selectWinner } from "./winner.ts";
import type { LaneRunRecord } from "./types.ts";

const EditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
  newText: Type.String({ description: "New text to replace the old text with" }),
});

const ReplanFlowParams = Type.Object({
  task: Type.String({ description: "Goal for this flow. Lanes may have different concrete APIs and will replan." }),
  context: Type.Optional(Type.String({ description: "Optional context for the flow" })),
  constraints: Type.Optional(Type.String({ description: "Optional constraints/instructions" })),
});


export interface AbExtensionOptions {
  experimentDirs?: string[];
  /**
   * Optional base directory (absolute path or file:// URL) used to resolve relative experimentDirs.
   * If omitted, pi-lab will attempt to infer the caller extension directory from stack traces.
   */
  baseDir?: string;
}

function detectExtensionCallerDir(): string | undefined {
  const stack = new Error().stack ?? "";
  const lines = stack.split("\n").slice(2);

  for (const line of lines) {
    const match = line.match(/\((.+):\d+:\d+\)$/) ?? line.match(/at (.+):\d+:\d+$/);
    if (!match) continue;

    let rawPath = match[1];
    if (!rawPath) continue;

    if (rawPath.startsWith("file://")) {
      try {
        rawPath = fileURLToPath(rawPath);
      } catch {
        continue;
      }
    }

    if (!rawPath.includes("/") && !rawPath.includes("\\")) continue;
    if (rawPath.includes("node:internal") || rawPath.includes("node_modules/@mariozechner/pi-coding-agent")) continue;
    if (rawPath.includes("/pi-extension/lab/index.")) continue;
    if (!rawPath.includes(".") ) continue;

    return dirname(rawPath);
  }

  return undefined;
}

function normalizeBaseDir(baseDir: string | undefined): string | undefined {
  const trimmed = baseDir?.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("file://")) {
    try {
      return dirname(fileURLToPath(trimmed));
    } catch {
      return undefined;
    }
  }

  if (trimmed.startsWith("~/")) {
    return resolve(homedir(), trimmed.slice(2));
  }

  return resolve(trimmed);
}

function resolveExperimentDirs(experimentDirs: string[] | undefined, baseDir?: string): string[] {
  const callerDir = normalizeBaseDir(baseDir) ?? detectExtensionCallerDir() ?? process.cwd();
  const unique = new Set<string>();
  const resolved: string[] = [];

  for (const raw of experimentDirs ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const abs = trimmed.startsWith("~/")
      ? resolve(homedir(), trimmed.slice(2))
      : resolve(callerDir, trimmed);
    if (unique.has(abs)) continue;
    unique.add(abs);
    resolved.push(abs);
  }

  return resolved;
}

function summarizeLaneFailures(records: LaneRunRecord[]) {
  const failures = records
    .filter((r) => r.status !== "success")
    .map((r) => ({
      lane_id: r.lane_id,
      status: r.status,
      error: r.error,
      process_exit_code: r.process_exit_code,
      lane_harness_used: r.lane_harness_used,
    }));

  return {
    lane_failures_count: failures.length,
    lane_failures: failures,
  };
}

function formatElapsedMs(elapsedMs?: number): string {
  if (elapsedMs == null) return "";
  const ms = Math.max(0, elapsedMs);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatModelLabel(model?: string): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function formatLaneStatus(experimentId: string, snapshot: LaneProgressSnapshot): string[] {
  const counts = {
    pending: snapshot.lanes.filter((lane) => lane.status === "pending").length,
    running: snapshot.lanes.filter((lane) => lane.status === "running").length,
    success: snapshot.lanes.filter((lane) => lane.status === "success").length,
    timeout: snapshot.lanes.filter((lane) => lane.status === "timeout").length,
    error: snapshot.lanes.filter((lane) => lane.status === "error").length,
  };

  const lines = snapshot.lanes.map((lane) => {
    const icon =
      lane.status === "pending"
        ? "○"
        : lane.status === "running"
          ? "⏳"
          : lane.status === "success"
            ? "✅"
            : lane.status === "timeout"
              ? "⏱"
              : "❌";
    const parts = [
      formatElapsedMs(lane.elapsed_ms),
      lane.lane_model ? `model ${formatModelLabel(lane.lane_model)}` : undefined,
      lane.lane_harness,
      lane.patch_bytes != null ? `patch ${lane.patch_bytes}B` : undefined,
      lane.total_tokens != null ? `${lane.total_tokens} tok` : undefined,
      lane.process_exit_code != null ? `exit ${lane.process_exit_code}` : undefined,
    ].filter(Boolean);
    const meta = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
    const error = lane.error ? ` · ${lane.error}` : "";
    return `${icon} ${lane.lane_id}${meta}${error}`;
  });

  const runLabel = snapshot.run_id ? `run ${snapshot.run_id.slice(0, 8)}` : "";
  const summary = `${counts.success}/${snapshot.lanes.length} done · ${counts.running} running · ${counts.pending} pending${counts.error || counts.timeout ? ` · ${counts.error} errors · ${counts.timeout} timeouts` : ""}`;
  return [`pi-lab · ${experimentId}`, `${summary}${runLabel ? ` · ${runLabel}` : ""}` , ...lines];
}

function frameTop(theme: any, title: string, info: string, width: number): string {
  const border = (text: string) => theme.fg("borderAccent", text);
  if (width <= 0) return "";
  if (width === 1) return border("╮");
  const inner = Math.max(0, width - 2);
  const label = info ? `${title} · ${info}` : title;
  const display = truncateToWidth(` ${label} `, inner, "", false);
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(display)));
  return border("╭") + theme.fg("accent", display) + border(`${fill}╮`);
}

function frameLine(theme: any, text: string, width: number): string {
  const border = (value: string) => theme.fg("borderAccent", value);
  if (width <= 0) return "";
  if (width === 1) return border("│");
  if (width === 2) return border("││");
  const inner = Math.max(0, width - 4);
  const display = truncateToWidth(text, inner, "", true);
  return `${border("│")} ${display} ${border("│")}`;
}

function frameTextLines(theme: any, text: string, width: number): string[] {
  if (width <= 4) return [frameLine(theme, text, width)];
  const inner = Math.max(1, width - 4);
  const wrapped = wrapTextWithAnsi(text, inner);
  return wrapped.length > 0 ? wrapped.map((line) => frameLine(theme, line, width)) : [frameLine(theme, "", width)];
}

function frameBottom(theme: any, width: number): string {
  const border = (text: string) => theme.fg("borderAccent", text);
  if (width <= 0) return "";
  if (width === 1) return border("╯");
  return border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function updateLaneWidget(ctx: any, widgetKey: string, experimentId: string, snapshot?: LaneProgressSnapshot): void {
  if (!ctx?.hasUI) return;
  if (!snapshot) {
    ctx.ui.setWidget(widgetKey, undefined);
    return;
  }

  const lines = formatLaneStatus(experimentId, snapshot);
  ctx.ui.setWidget(
    widgetKey,
    (_tui: any, theme: any) => ({
      invalidate() {},
      render(width: number) {
        const body = lines.slice(1).flatMap((line) => frameTextLines(theme, line, width));
        return [frameTop(theme, lines[0], `${snapshot.lanes.length} lanes`, width), ...body, frameBottom(theme, width)].filter(Boolean);
      },
    }),
    { placement: "aboveEditor" },
  );
}

type ExperimentWinnerSummary = {
  winner_lane_id: string;
  winner_mode: string;
  reason?: string;
  selection_source?: string;
  fallback_reason_code?: string;
  llm_error?: string;
  llm_error_code?: string;
};

type ExperimentGradingSummary = {
  winner_lane_id: string;
  scores?: Array<{ lane_id: string; score: number; reason?: string }>;
  confidence?: number;
  tie_break_used?: string;
  notes?: string;
};

function mdCell(value: unknown): string {
  if (value == null) return "—";
  const text = String(value).trim();
  if (!text) return "—";
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " <br> ");
}

function loadGradingSummary(runDir: string): ExperimentGradingSummary | undefined {
  try {
    const path = resolve(runDir, "artifacts", "grading-output.json");
    return JSON.parse(readFileSync(path, "utf8")) as ExperimentGradingSummary;
  } catch {
    return undefined;
  }
}

function buildExperimentSummaryMarkdown(
  experimentId: string,
  lanes: LaneRunRecord[],
  winner: ExperimentWinnerSummary,
  runDir: string,
): string {
  const lines = [
    `### pi-lab summary · ${experimentId}`,
    "",
    "| Lane | Status | Latency ms | Tokens | Patch bytes | Model | Harness | Exit | Error |",
    "|---|---|---:|---:|---:|---|---|---:|---|",
    ...lanes.map((lane) => {
      const harness = lane.lane_harness_used ?? lane.lane_harness_requested;
      return `| ${mdCell(lane.lane_id)} | ${mdCell(lane.status)} | ${mdCell(lane.latency_ms)} | ${mdCell(lane.total_tokens)} | ${mdCell(lane.patch_bytes)} | ${mdCell(lane.lane_model)} | ${mdCell(harness)} | ${mdCell(lane.process_exit_code)} | ${mdCell(lane.error)} |`;
    }),
    "",
    `**Winner:** \`${winner.winner_lane_id}\` via \`${winner.winner_mode}\``,
  ];

  if (winner.reason) lines.push(`**Reason:** ${winner.reason}`);
  if (winner.selection_source) lines.push(`**Selection source:** \`${winner.selection_source}\``);
  if (winner.fallback_reason_code) lines.push(`**Fallback reason:** \`${winner.fallback_reason_code}\``);

  const grading = loadGradingSummary(runDir);
  if (grading) {
    lines.push("", "#### LLM grading", "", "| Lane | Score | Reason |", "|---|---:|---|");
    for (const item of grading.scores ?? []) {
      lines.push(`| ${mdCell(item.lane_id)} | ${mdCell(item.score.toFixed(3))} | ${mdCell(item.reason)} |`);
    }
    lines.push(``, `**LLM winner:** \`${grading.winner_lane_id}\``);
    if (grading.confidence != null) lines.push(`**Confidence:** ${grading.confidence}`);
    if (grading.tie_break_used) lines.push(`**Tie break used:** ${grading.tie_break_used}`);
    if (grading.notes) lines.push(`**Notes:** ${grading.notes}`);
  } else if (winner.llm_error || winner.llm_error_code) {
    lines.push("", "#### LLM grading", "", `**Error code:** ${mdCell(winner.llm_error_code)}`);
    if (winner.llm_error) lines.push(`**Error:** ${winner.llm_error}`);
  }

  return lines.join("\n");
}

function combineToolTextWithSummary(baseText: string, _summaryMarkdown: string): string {
  return baseText.trim();
}

type ParsedSummaryRow = {
  lane_id: string;
  status: string;
  latency_ms: string;
  tokens: string;
  patch_bytes: string;
  model: string;
  harness: string;
  exit: string;
  error: string;
};

function stripSimpleMarkdown(text: string): string {
  return text.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

function parseMarkdownTableCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
  if (/^\|[-:| ]+\|$/.test(trimmed)) return undefined;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => stripSimpleMarkdown(cell));
}

function parseSummaryRows(summaryMarkdown: string): ParsedSummaryRow[] {
  const lines = summaryMarkdown.split("\n");
  const rows: ParsedSummaryRow[] = [];
  let inLaneTable = false;

  for (const line of lines) {
    if (line.startsWith("| Lane | Status | Latency ms | Tokens | Patch bytes | Model | Harness | Exit | Error |")) {
      inLaneTable = true;
      continue;
    }
    if (!inLaneTable) continue;
    const cells = parseMarkdownTableCells(line);
    if (!cells) {
      if (line.trim()) inLaneTable = false;
      continue;
    }
    if (cells.length !== 9 || cells[0] === "Lane") continue;
    rows.push({
      lane_id: cells[0] ?? "—",
      status: cells[1] ?? "—",
      latency_ms: cells[2] ?? "—",
      tokens: cells[3] ?? "—",
      patch_bytes: cells[4] ?? "—",
      model: cells[5] ?? "—",
      harness: cells[6] ?? "—",
      exit: cells[7] ?? "—",
      error: cells[8] ?? "—",
    });
  }

  return rows;
}

function parseSummaryValue(summaryMarkdown: string, label: string): string | undefined {
  const line = summaryMarkdown.split("\n").find((entry) => entry.startsWith(label));
  if (!line) return undefined;
  return stripSimpleMarkdown(line.slice(label.length).trim());
}

function renderAbToolResult(
  result: any,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: any,
  fallback?: (result: any, options: { expanded?: boolean; isPartial?: boolean }, theme: any) => any,
) {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "pi-lab running lanes..."), 0, 0);
  }

  const ab = result?.details?.ab as { summary_markdown?: string; experiment_id?: string; winner_lane_id?: string; winner_mode?: string } | undefined;
  const summaryMarkdown = ab?.summary_markdown;
  if (!summaryMarkdown) {
    return fallback ? fallback(result, options, theme) : new Text(String(result?.content?.[0]?.type === "text" ? result.content[0].text : "Done."), 0, 0);
  }

  const rows = parseSummaryRows(summaryMarkdown);
  const reason = parseSummaryValue(summaryMarkdown, "**Reason:**");
  const selectionSource = parseSummaryValue(summaryMarkdown, "**Selection source:**");
  const llmWinner = parseSummaryValue(summaryMarkdown, "**LLM winner:**");
  const confidence = parseSummaryValue(summaryMarkdown, "**Confidence:**");
  const tieBreak = parseSummaryValue(summaryMarkdown, "**Tie break used:**");
  const notes = parseSummaryValue(summaryMarkdown, "**Notes:**");

  let text = `\n${theme.fg("accent", `pi-lab summary · ${ab?.experiment_id ?? "experiment"}`)}`;
  text += `\n${theme.fg("success", `winner ${ab?.winner_lane_id ?? "—"}`)}${theme.fg("dim", ` via ${ab?.winner_mode ?? "—"}`)}`;
  if (selectionSource && selectionSource !== ab?.winner_mode) {
    text += `\n${theme.fg("dim", `selection source: ${selectionSource}`)}`;
  }
  if (reason) {
    text += `\n${theme.fg("dim", reason)}`;
  }

  for (const row of rows) {
    const statusColor = row.status === "success" ? "success" : row.status === "timeout" ? "warning" : row.status === "error" ? "error" : "muted";
    const latency = row.latency_ms !== "—" ? ` · ${row.latency_ms}ms` : "";
    const patch = row.patch_bytes !== "—" ? ` · patch ${row.patch_bytes}B` : "";
    const model = row.model !== "—" ? ` · model ${row.model}` : "";
    const harness = row.harness !== "—" ? ` · ${row.harness}` : "";
    const exit = row.exit !== "—" ? ` · exit ${row.exit}` : "";
    text += `\n${theme.fg(statusColor, `${row.status === "success" ? "✓" : row.status === "timeout" ? "⏱" : row.status === "error" ? "✗" : "○"} ${row.lane_id}`)}${theme.fg("dim", `${latency}${patch}${model}${harness}${exit}`)}`;
    if (row.error && row.error !== "—") {
      text += `\n${theme.fg("error", `  ${row.error}`)}`;
    }
  }

  if (llmWinner || confidence || tieBreak) {
    const parts = [llmWinner ? `llm ${llmWinner}` : undefined, confidence ? `confidence ${confidence}` : undefined, tieBreak ? `tie ${tieBreak}` : undefined].filter(Boolean);
    if (parts.length > 0) text += `\n${theme.fg("muted", parts.join(" · "))}`;
  }

  if (options.expanded) {
    if (notes) {
      text += `\n\n${theme.fg("muted", `notes: ${notes}`)}`;
    }
    text += `\n\n${summaryMarkdown}`;
  }

  return new Text(text, 0, 0);
}

const NON_GIT_BASELINE_FALLBACK_REASON = "non_git_baseline_lane";

function nonGitBaselineFallbackMessage(errorText: string): string {
  return [
    "pi-lab requires a git repository for isolated worktrees.",
    "Current cwd is not inside a git repo, so pi-lab ran only the baseline lane in-place.",
    `Git error: ${errorText.trim()}`,
  ].join(" ");
}

type NativeToolDelegate = {
  description?: string;
  parameters?: any;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: any,
    execCtx?: any,
  ) => Promise<any>;
};

function createBuiltinNativeToolDelegate(toolName: string, cwd: string): NativeToolDelegate | undefined {
  if (toolName === "read") return createReadTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "bash") return createBashTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "edit") return createEditTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "write") return createWriteTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "grep") return createGrepTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "find") return createFindTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "ls") return createLsTool(cwd) as unknown as NativeToolDelegate;
  return undefined;
}

export function resolveFixedArgsInterceptorSupport(
  toolName: string,
  cwd: string,
  existing?: {
    description?: string;
    parameters?: any;
    execute?: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: any,
      execCtx?: any,
    ) => Promise<any>;
  },
  configured?: {
    description?: string;
    parameters?: any;
  },
): {
  description?: string;
  parameters?: any;
  nativeTool?: NativeToolDelegate;
  error?: string;
  warning?: string;
} {
  const builtin = createBuiltinNativeToolDelegate(toolName, cwd);
  const description =
    existing?.description ??
    configured?.description ??
    builtin?.description ??
    `AB fixed-args interceptor for '${toolName}'. Runs experiment lanes with identical tool args and returns the winning lane result.`;
  const parameters = existing?.parameters ?? configured?.parameters ?? builtin?.parameters;

  if (!parameters) {
    return {
      error:
        `Cannot register fixed_args interceptor for '${toolName}' because no parameter schema is available. ` +
        `Custom fixed_args tools must expose a concrete parameter schema before pi-lab can intercept them.`,
    };
  }

  if (existing?.execute) {
    return {
      description,
      parameters,
      nativeTool: {
        description,
        parameters,
        execute: (toolCallId, params, signal, onUpdate, execCtx) =>
          existing.execute!(toolCallId, params, signal, onUpdate, execCtx),
      },
    };
  }

  if (builtin) {
    return {
      description,
      parameters,
      nativeTool: builtin,
    };
  }

  return {
    description,
    parameters,
    warning:
      `Registered fixed_args interceptor for '${toolName}' without a native delegate. ` +
      `Matching experiment runs will work, but trigger bypass/native fallback for this custom tool is unavailable.`,
  };
}

function fairnessManifestFields(fairness: CapabilityFairnessTelemetry): Record<string, unknown> {
  return {
    capability_policy: fairness.capability_policy,
    capability_intersection_keys: fairness.capability_intersection_keys,
    capability_union_keys: fairness.capability_union_keys,
    lane_capabilities: fairness.lane_capabilities,
  };
}

function inferLaneHarness(executionStrategy: unknown): "direct" | "pi_prompt" {
  return canonicalExecutionStrategy(executionStrategy) === "fixed_args" ? "direct" : "pi_prompt";
}

async function runFixedArgsToolExperiment(
  params: Record<string, unknown>,
  toolName: string,
  toolCallId: string,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctx: any,
  cooldownState: Map<string, number>,
  experimentDirs: string[] | undefined,
  nativeTool: NativeToolDelegate | undefined,
) {
  const now = Date.now();
  const matched = selectExperimentForTool(ctx.cwd, toolName, params, now, cooldownState, {
    executionStrategy: "fixed_args",
    experimentDirs,
  });

  let loaded = matched;
  let triggerBypassed = false;

  if (!loaded) {
    if (nativeTool) {
      return nativeTool.execute(toolCallId, params, signal, onUpdate, ctx);
    }

    loaded = loadExperiments(ctx.cwd, { experimentDirs })
      .filter((e) => e.experiment.enabled !== false)
      .filter((e) => (e.validation?.errors?.length ?? 0) === 0)
      .filter((e) => toolNameOf(e.experiment) === toolName)
      .find((e) => canonicalExecutionStrategy(executionStrategyOf(e.experiment)) === "fixed_args") ?? null;

    if (!loaded) {
      throw new Error(
        `No fixed_args experiment configured for tool '${toolName}', and no native delegate is available.`,
      );
    }

    triggerBypassed = true;
  }

  const experiment = loaded.experiment;
  cooldownState.set(experiment.id, now);

  const run = createRunContext(ctx.cwd, loaded.source);
  writeRunManifest(run, experiment, {
    source: loaded.source,
    config_path: loaded.path,
    configured_winner_mode: winnerModeOf(experiment),
    intercepted_tool: toolName,
    intercepted_args: params,
    execution_strategy: canonicalExecutionStrategy(executionStrategyOf(experiment)),
    lane_harness: process.env.PI_AB_LANE_HARNESS ?? inferLaneHarness(executionStrategyOf(experiment)),
    trigger_bypassed: triggerBypassed || undefined,
    trigger_bypass_reason: triggerBypassed ? "no_native_delegate_for_nonmatching_trigger" : undefined,
    stage: "started",
  });

  const laneStatusKey = "ab-lanes";
  const gitRepo = await detectGitRepository(ctx.cwd, signal);

  if (!gitRepo.ok) {
    const warning = nonGitBaselineFallbackMessage(gitRepo.error);
    ctx.ui.notify(warning, "warning");

    const fallback = await runBaselineFixedArgsFallbackNoGit(loaded, run, ctx.cwd, toolName, params, signal);
    const lanes = [fallback.lane];
    writeLaneRecords(run, lanes);
    writeRunManifest(run, experiment, {
      ...summarizeLaneFailures(lanes),
      stage: fallback.lane.status === "success" ? "completed_fallback_baseline" : "failed",
      error: gitRepo.error,
      reason: warning,
      winner_lane_id: fallback.lane.status === "success" ? fallback.lane.lane_id : undefined,
      winner_mode: fallback.lane.status === "success" ? "baseline-no-git-fallback" : undefined,
      selection_source: fallback.lane.status === "success" ? "baseline_no_git_fallback" : undefined,
      fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
    });

    if (fallback.lane.status !== "success") {
      throw new Error(`Baseline lane failed while running outside a git repo: ${fallback.lane.error ?? "unknown error"}`);
    }

    const summaryMarkdown = buildExperimentSummaryMarkdown(
      experiment.id,
      lanes,
      {
        winner_lane_id: fallback.lane.lane_id,
        winner_mode: "baseline-no-git-fallback",
        selection_source: "baseline_no_git_fallback",
        fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
      },
      run.dir,
    );

    return {
      content: [{ type: "text", text: combineToolTextWithSummary(fallback.lane.output_text ?? "Done.", summaryMarkdown) }],
      details: {
        ...(fallback.patchText ? { diff: fallback.patchText, firstChangedLine: undefined } : {}),
        ab: {
          run_id: run.runId,
          experiment_id: experiment.id,
          winner_lane_id: fallback.lane.lane_id,
          winner_mode: "baseline-no-git-fallback",
          selection_source: "baseline_no_git_fallback",
          fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
          no_git: true,
          summary_markdown: summaryMarkdown,
        },
      },
    };
  }

  try {
    const laneRun = await runExperimentLanesFixedArgsTool(
      loaded,
      run,
      ctx.cwd,
      toolName,
      params,
      signal,
      (snapshot) => {
        updateLaneWidget(ctx, laneStatusKey, experiment.id, snapshot);
      },
    );

    const lanes = laneRun.records;
    writeLaneRecords(run, lanes);
    writeRunManifest(run, experiment, {
      ...fairnessManifestFields(laneRun.fairness),
      ...summarizeLaneFailures(lanes),
    });

    const winner = await selectWinner(loaded, run, ctx.cwd, lanes, { intercepted_tool: toolName, intercepted_args: params as Record<string, unknown> }, ctx.model, signal);
    const selected = laneById(lanes, winner.winner_lane_id);
    if (!selected) {
      throw new Error(`Winner lane ${winner.winner_lane_id} not found.`);
    }
    if (selected.status !== "success") {
      throw new Error(`Winner lane ${winner.winner_lane_id} is not successful (${selected.status}).`);
    }

    const policy = defaultPolicy(experiment);
    const selectedPatchPath = selected.patch_path && (selected.patch_bytes ?? 0) > 0 ? selected.patch_path : undefined;
    let appliedPatchText: string | undefined;
    let selectionSource = winner.selection_source;
    let fallbackReasonCode = winner.fallback_reason_code;
    let returnedLane = selected;
    let returnedWinnerMode = winner.mode_used;

    if (selectedPatchPath) {
      const apply = await applyPatchToMain(ctx.cwd, selectedPatchPath, signal);
      if (!apply.ok) {
        if (policy.on_winner_apply_failure === "fallback_baseline_then_fail") {
          const baseline = laneById(lanes, getBaselineLaneId(experiment));
          const baselinePatchPath = baseline?.patch_path && (baseline.patch_bytes ?? 0) > 0 ? baseline.patch_path : undefined;
          if (baseline && baselinePatchPath && baselinePatchPath !== selectedPatchPath) {
            const fallbackApply = await applyPatchToMain(ctx.cwd, baselinePatchPath, signal);
            if (fallbackApply.ok) {
              appliedPatchText = readFileSync(baselinePatchPath, "utf8");
              returnedLane = baseline;
              selectionSource = "baseline_apply_fallback";
              fallbackReasonCode = "winner_apply_failed_baseline_apply_succeeded";
              returnedWinnerMode = `${winner.mode_used} + baseline-apply-fallback` as typeof returnedWinnerMode;
            }
          }
        }

        if (!appliedPatchText) {
          throw new Error(`Winner patch apply failed: ${apply.error ?? "unknown error"}`);
        }
      } else {
        appliedPatchText = readFileSync(selectedPatchPath, "utf8");
      }
    }

    writeRunManifest(run, experiment, {
      stage: "completed",
      winner_lane_id: returnedLane.lane_id,
      winner_mode: returnedWinnerMode,
      reason: winner.reason,
      selection_source: selectionSource,
      fallback_reason_code: fallbackReasonCode,
      llm_error_code: winner.llm_error_code,
    });

    const summaryMarkdown = buildExperimentSummaryMarkdown(
      experiment.id,
      lanes,
      {
        winner_lane_id: returnedLane.lane_id,
        winner_mode: returnedWinnerMode,
        reason: winner.reason,
        selection_source: selectionSource,
        fallback_reason_code: fallbackReasonCode,
        llm_error: winner.llm_error,
        llm_error_code: winner.llm_error_code,
      },
      run.dir,
    );

    return {
      content: [{ type: "text", text: combineToolTextWithSummary(returnedLane.output_text ?? "Done.", summaryMarkdown) }],
      details: {
        ...(appliedPatchText ? { diff: appliedPatchText, firstChangedLine: undefined } : {}),
        ab: {
          run_id: run.runId,
          experiment_id: experiment.id,
          winner_lane_id: returnedLane.lane_id,
          winner_mode: returnedWinnerMode,
          selection_source: selectionSource,
          fallback_reason_code: fallbackReasonCode,
          llm_error: winner.llm_error,
          llm_error_code: winner.llm_error_code,
          capability_policy: laneRun.fairness.capability_policy,
          summary_markdown: summaryMarkdown,
        },
      },
    };
  } catch (err: any) {
    const errorText = err?.message ?? String(err);
    writeRunManifest(run, experiment, {
      stage: "failed",
      error: errorText,
      fallback_reason_code: "ab_failed_no_fallback",
    });
    throw err;
  } finally {
    updateLaneWidget(ctx, laneStatusKey, experiment.id, undefined);
    pruneEmptyRunScaffolding(run);
  }
}

async function runSingleCallFlowExperiment(
  params: { task: string; context?: string; constraints?: string },
  toolName: string,
  signal: AbortSignal | undefined,
  ctx: any,
  cooldownState: Map<string, number>,
  experimentDirs: string[] | undefined,
) {
  const now = Date.now();
  const loaded = selectExperimentForTool(ctx.cwd, toolName, params as Record<string, unknown>, now, cooldownState, {
    executionStrategy: "lane_single_call",
    experimentDirs,
  });
  if (!loaded) {
    throw new Error(
      `No active lane_single_call experiment matched tool '${toolName}'. Configure tool.name='${toolName}' and execution.strategy='lane_single_call'.`,
    );
  }

  const experiment = loaded.experiment;
  cooldownState.set(experiment.id, now);

  const run = createRunContext(ctx.cwd, loaded.source);
  writeRunManifest(run, experiment, {
    source: loaded.source,
    config_path: loaded.path,
    configured_winner_mode: winnerModeOf(experiment),
    intercepted_tool: toolName,
    intercepted_args: {
      task_len: params.task.length,
      context_len: (params.context ?? "").length,
      constraints_len: (params.constraints ?? "").length,
    },
    execution_strategy: canonicalExecutionStrategy(executionStrategyOf(experiment)),
    lane_harness: inferLaneHarness(executionStrategyOf(experiment)),
    stage: "started",
  });

  const laneStatusKey = "ab-lanes";
  const gitRepo = await detectGitRepository(ctx.cwd, signal);

  if (!gitRepo.ok) {
    const warning = nonGitBaselineFallbackMessage(gitRepo.error);
    ctx.ui.notify(warning, "warning");

    const fallback = await runBaselineSingleCallFallbackNoGit(loaded, run, ctx.cwd, toolName, params, signal, ctx.model);
    const lanes = [fallback.lane];
    writeLaneRecords(run, lanes);
    writeRunManifest(run, experiment, {
      ...summarizeLaneFailures(lanes),
      stage: fallback.lane.status === "success" ? "completed_fallback_baseline" : "failed",
      error: gitRepo.error,
      reason: warning,
      winner_lane_id: fallback.lane.status === "success" ? fallback.lane.lane_id : undefined,
      winner_mode: fallback.lane.status === "success" ? "baseline-no-git-fallback" : undefined,
      selection_source: fallback.lane.status === "success" ? "baseline_no_git_fallback" : undefined,
      fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
    });

    if (fallback.lane.status !== "success") {
      throw new Error(`Baseline lane failed while running outside a git repo: ${fallback.lane.error ?? "unknown error"}`);
    }

    const summaryMarkdown = buildExperimentSummaryMarkdown(
      experiment.id,
      lanes,
      {
        winner_lane_id: fallback.lane.lane_id,
        winner_mode: "baseline-no-git-fallback",
        selection_source: "baseline_no_git_fallback",
        fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
      },
      run.dir,
    );

    return {
      content: [{ type: "text", text: combineToolTextWithSummary(fallback.lane.output_text ?? "Flow completed.", summaryMarkdown) }],
      details: {
        ab: {
          run_id: run.runId,
          experiment_id: experiment.id,
          winner_lane_id: fallback.lane.lane_id,
          winner_mode: "baseline-no-git-fallback",
          selection_source: "baseline_no_git_fallback",
          fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
          no_git: true,
          summary_markdown: summaryMarkdown,
        },
      },
    };
  }

  try {
    const laneRun = await runExperimentLanesSingleCall(
      loaded,
      run,
      ctx.cwd,
      toolName,
      params,
      signal,
      (snapshot) => {
        updateLaneWidget(ctx, laneStatusKey, experiment.id, snapshot);
      },
      ctx.model,
    );

    const lanes = laneRun.records;
    writeLaneRecords(run, lanes);
    writeRunManifest(run, experiment, {
      ...fairnessManifestFields(laneRun.fairness),
      ...summarizeLaneFailures(lanes),
    });

    const winner = await selectWinner(loaded, run, ctx.cwd, lanes, { intercepted_tool: toolName, intercepted_args: params as Record<string, unknown> }, ctx.model, signal);
    const selected = laneById(lanes, winner.winner_lane_id);
    if (!selected) {
      throw new Error(`Winner lane ${winner.winner_lane_id} not found.`);
    }
    if (selected.status !== "success") {
      throw new Error(`Winner lane ${winner.winner_lane_id} is not successful (${selected.status}).`);
    }

    writeRunManifest(run, experiment, {
      stage: "completed",
      winner_lane_id: selected.lane_id,
      winner_mode: winner.mode_used,
      reason: winner.reason,
      selection_source: winner.selection_source,
      fallback_reason_code: winner.fallback_reason_code,
      llm_error_code: winner.llm_error_code,
    });

    const summaryMarkdown = buildExperimentSummaryMarkdown(
      experiment.id,
      lanes,
      {
        winner_lane_id: selected.lane_id,
        winner_mode: winner.mode_used,
        reason: winner.reason,
        selection_source: winner.selection_source,
        fallback_reason_code: winner.fallback_reason_code,
        llm_error: winner.llm_error,
        llm_error_code: winner.llm_error_code,
      },
      run.dir,
    );

    return {
      content: [{ type: "text", text: combineToolTextWithSummary(selected.output_text ?? "Flow completed.", summaryMarkdown) }],
      details: {
        ab: {
          run_id: run.runId,
          experiment_id: experiment.id,
          winner_lane_id: selected.lane_id,
          winner_mode: winner.mode_used,
          selection_source: winner.selection_source,
          fallback_reason_code: winner.fallback_reason_code,
          llm_error: winner.llm_error,
          llm_error_code: winner.llm_error_code,
          capability_policy: laneRun.fairness.capability_policy,
          summary_markdown: summaryMarkdown,
        },
      },
    };
  } catch (err: any) {
    const errorText = err?.message ?? String(err);
    writeRunManifest(run, experiment, {
      stage: "failed",
      error: errorText,
      fallback_reason_code: "ab_failed_no_fallback",
    });
    throw err;
  } finally {
    updateLaneWidget(ctx, laneStatusKey, experiment.id, undefined);
    pruneEmptyRunScaffolding(run);
  }
}

async function runMultiCallFlowExperiment(
  params: { task: string; context?: string; constraints?: string },
  toolName: string,
  signal: AbortSignal | undefined,
  ctx: any,
  cooldownState: Map<string, number>,
  experimentDirs: string[] | undefined,
) {
  const now = Date.now();
  const loaded = selectExperimentForTool(ctx.cwd, toolName, params as Record<string, unknown>, now, cooldownState, {
    executionStrategy: "lane_multi_call",
    experimentDirs,
  });
  if (!loaded) {
    throw new Error(
      `No active lane_multi_call experiment matched tool '${toolName}'. Configure tool.name='${toolName}' and execution.strategy='lane_multi_call'.`,
    );
  }

  const experiment = loaded.experiment;
  cooldownState.set(experiment.id, now);

  const run = createRunContext(ctx.cwd, loaded.source);
  writeRunManifest(run, experiment, {
    source: loaded.source,
    config_path: loaded.path,
    configured_winner_mode: winnerModeOf(experiment),
    intercepted_tool: toolName,
    intercepted_args: {
      task_len: params.task.length,
      context_len: (params.context ?? "").length,
      constraints_len: (params.constraints ?? "").length,
    },
    execution_strategy: canonicalExecutionStrategy(executionStrategyOf(experiment)),
    lane_harness: inferLaneHarness(executionStrategyOf(experiment)),
    stage: "started",
  });

  const laneStatusKey = "ab-lanes";
  const gitRepo = await detectGitRepository(ctx.cwd, signal);

  if (!gitRepo.ok) {
    const warning = nonGitBaselineFallbackMessage(gitRepo.error);
    ctx.ui.notify(warning, "warning");

    const fallback = await runBaselineMultiCallFallbackNoGit(loaded, run, ctx.cwd, toolName, params, signal, ctx.model);
    const lanes = [fallback.lane];
    writeLaneRecords(run, lanes);
    writeRunManifest(run, experiment, {
      ...summarizeLaneFailures(lanes),
      stage: fallback.lane.status === "success" ? "completed_fallback_baseline" : "failed",
      error: gitRepo.error,
      reason: warning,
      winner_lane_id: fallback.lane.status === "success" ? fallback.lane.lane_id : undefined,
      winner_mode: fallback.lane.status === "success" ? "baseline-no-git-fallback" : undefined,
      selection_source: fallback.lane.status === "success" ? "baseline_no_git_fallback" : undefined,
      fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
    });

    if (fallback.lane.status !== "success") {
      throw new Error(`Baseline lane failed while running outside a git repo: ${fallback.lane.error ?? "unknown error"}`);
    }

    const summaryMarkdown = buildExperimentSummaryMarkdown(
      experiment.id,
      lanes,
      {
        winner_lane_id: fallback.lane.lane_id,
        winner_mode: "baseline-no-git-fallback",
        selection_source: "baseline_no_git_fallback",
        fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
      },
      run.dir,
    );

    return {
      content: [{ type: "text", text: combineToolTextWithSummary(fallback.lane.output_text ?? "Flow completed.", summaryMarkdown) }],
      details: {
        ab: {
          run_id: run.runId,
          experiment_id: experiment.id,
          winner_lane_id: fallback.lane.lane_id,
          winner_mode: "baseline-no-git-fallback",
          selection_source: "baseline_no_git_fallback",
          fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
          no_git: true,
          summary_markdown: summaryMarkdown,
        },
      },
    };
  }

  try {
    const lanes = await runExperimentLanesMultiCall(
      loaded,
      run,
      ctx.cwd,
      toolName,
      params,
      signal,
      (snapshot) => {
        updateLaneWidget(ctx, laneStatusKey, experiment.id, snapshot);
      },
      ctx.model,
    );

    writeLaneRecords(run, lanes);
    writeRunManifest(run, experiment, {
      ...summarizeLaneFailures(lanes),
    });

    const winner = await selectWinner(loaded, run, ctx.cwd, lanes, { intercepted_tool: toolName, intercepted_args: params as Record<string, unknown> }, ctx.model, signal);
    const selected = laneById(lanes, winner.winner_lane_id);
    if (!selected) {
      throw new Error(`Winner lane ${winner.winner_lane_id} not found.`);
    }
    if (selected.status !== "success") {
      throw new Error(`Winner lane ${winner.winner_lane_id} is not successful (${selected.status}).`);
    }

    let returnedLane = selected;
    let returnedWinnerMode: string = winner.mode_used;
    let selectionSource = winner.selection_source;
    let fallbackReasonCode = winner.fallback_reason_code;
    let appliedPatch: string | undefined;
    let fallbackApplied = false;

    const selectedPatchPath = selected.patch_path && (selected.patch_bytes ?? 0) > 0 ? selected.patch_path : undefined;
    if (selectedPatchPath) {
      const apply = await applyPatchToMain(ctx.cwd, selectedPatchPath, signal);
      if (!apply.ok) {
        if (policy.on_winner_apply_failure === "fallback_baseline_then_fail") {
          const baseline = laneById(lanes, getBaselineLaneId(experiment));
          const baselinePatchPath = baseline?.patch_path && (baseline.patch_bytes ?? 0) > 0 ? baseline.patch_path : undefined;
          if (baseline && baselinePatchPath && baselinePatchPath !== selectedPatchPath) {
            const fallbackApply = await applyPatchToMain(ctx.cwd, baselinePatchPath, signal);
            if (fallbackApply.ok) {
              returnedLane = baseline;
              returnedWinnerMode = `${winner.mode_used} + baseline-apply-fallback`;
              selectionSource = "baseline_apply_fallback";
              fallbackReasonCode = "winner_apply_failed_baseline_apply_succeeded";
              appliedPatch = readFileSync(baselinePatchPath, "utf8");
              fallbackApplied = true;
            }
          }
        }

        if (!appliedPatch) {
          throw new Error(`Winner patch apply failed: ${apply.error ?? "unknown error"}`);
        }
      } else {
        appliedPatch = readFileSync(selectedPatchPath, "utf8");
      }
    }

    writeRunManifest(run, experiment, {
      stage: "completed",
      winner_lane_id: returnedLane.lane_id,
      winner_mode: returnedWinnerMode,
      reason: fallbackApplied ? `${winner.reason}; winner apply failed, baseline patch applied` : winner.reason,
      selection_source: selectionSource,
      fallback_reason_code: fallbackReasonCode,
      llm_error_code: winner.llm_error_code,
    });

    const summaryMarkdown = buildExperimentSummaryMarkdown(
      experiment.id,
      lanes,
      {
        winner_lane_id: returnedLane.lane_id,
        winner_mode: returnedWinnerMode,
        reason: fallbackApplied ? `${winner.reason}; winner apply failed, baseline patch applied` : winner.reason,
        selection_source: selectionSource,
        fallback_reason_code: fallbackReasonCode,
        llm_error: winner.llm_error,
        llm_error_code: winner.llm_error_code,
      },
      run.dir,
    );

    return {
      content: [{ type: "text", text: combineToolTextWithSummary(returnedLane.output_text ?? "Flow completed.", summaryMarkdown) }],
      details: {
        ...(appliedPatch ? { diff: appliedPatch, firstChangedLine: undefined } : {}),
        ab: {
          run_id: run.runId,
          experiment_id: experiment.id,
          winner_lane_id: returnedLane.lane_id,
          winner_mode: returnedWinnerMode,
          selection_source: selectionSource,
          fallback_applied: fallbackApplied || undefined,
          fallback_reason_code: fallbackReasonCode,
          llm_error: winner.llm_error,
          llm_error_code: winner.llm_error_code,
          summary_markdown: summaryMarkdown,
        },
      },
    };
  } catch (err: any) {
    const errorText = err?.message ?? String(err);
    writeRunManifest(run, experiment, {
      stage: "failed",
      error: errorText,
      fallback_reason_code: "ab_failed_no_fallback",
    });
    throw err;
  } finally {
    updateLaneWidget(ctx, laneStatusKey, experiment.id, undefined);
    pruneEmptyRunScaffolding(run);
  }
}

function formatExperimentEnabledBadge(loaded: { experiment: { enabled?: boolean } }): string {
  return loaded.experiment.enabled === false ? "off" : "on";
}

function formatExperimentListLine(loaded: ReturnType<typeof loadExperiments>[number]): string {
  const toggleHint = loaded.source === "project" || loaded.source === "global" ? "toggleable" : "read-only";
  return `• [${formatExperimentEnabledBadge(loaded)}] ${formatExperimentSummary(loaded)} · ${toggleHint}`;
}

function experimentSourceLabel(source: string): string {
  if (source === "project") return "local";
  if (source === "global") return "global";
  return source.replace(/^package:/, "pkg:");
}

function experimentUiDescription(loaded: ReturnType<typeof loadExperiments>[number]): string {
  const validation = loaded.validation;
  const parts = [
    `source: ${experimentSourceLabel(loaded.source)}`,
    `path: ${loaded.path}`,
    `tool: ${toolNameOf(loaded.experiment)}`,
    `winner: ${winnerModeOf(loaded.experiment)}`,
    `strategy: ${canonicalExecutionStrategy(executionStrategyOf(loaded.experiment))}`,
  ];
  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];
  if (errors.length > 0) parts.push(`errors: ${errors.join(" | ")}`);
  if (warnings.length > 0) parts.push(`warnings: ${warnings.join(" | ")}`);
  return parts.join("\n");
}

async function showExperimentsManager(ctx: any, experimentDirs?: string[]) {
  const experiments = loadExperiments(ctx.cwd, { experimentDirs });
  if (experiments.length === 0) {
    ctx.ui.notify("No A/B experiments found (global or project).", "warning");
    return;
  }

  await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (value?: unknown) => void) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("pi-lab experiments")), 0, 0));
    container.addChild(new Spacer(1));

    const items: SettingItem[] = experiments.map((loaded) => {
      const toggleable = loaded.source === "project" || loaded.source === "global";
      return {
        id: loaded.experiment.id,
        label: `${loaded.experiment.id} [${experimentSourceLabel(loaded.source)}]`,
        description: experimentUiDescription(loaded),
        currentValue: loaded.experiment.enabled === false ? "disabled" : "enabled",
        values: toggleable ? ["enabled", "disabled"] : undefined,
      } satisfies SettingItem;
    });

    const settingsList = new SettingsList(
      items,
      Math.min(Math.max(items.length + 2, 6), 16),
      getSettingsListTheme(),
      (id, newValue) => {
        const target = experiments.find((e) => e.experiment.id === id);
        if (!target || (target.source !== "project" && target.source !== "global")) {
          ctx.ui.notify(`Experiment '${id}' is read-only.`, "warning");
          return;
        }
        const enabled = newValue === "enabled";
        const result = setExperimentEnabled(target.path, target.experiment.id, enabled);
        if (!result.found) {
          ctx.ui.notify(`Experiment '${id}' was not found in ${target.path}.`, "error");
          return;
        }
        target.experiment.enabled = enabled;
        ctx.ui.notify(`Experiment '${id}' ${enabled ? "enabled" : "disabled"}.`, "info");
      },
      () => done(undefined),
      { enableSearch: true },
    );

    container.addChild(settingsList);

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

type LabRunSummary = {
  scope: "local" | "global";
  runId: string;
  dir: string;
  experimentId?: string;
  timestamp?: string;
  stage?: string;
  winnerLaneId?: string;
  winnerMode?: string;
  selectionSource?: string;
  reason?: string;
  error?: string;
};

function readRunSummary(scope: "local" | "global", dir: string, runId: string): LabRunSummary | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    return {
      scope,
      runId,
      dir,
      experimentId: manifest?.experiment_id,
      timestamp: manifest?.timestamp,
      stage: manifest?.stage,
      winnerLaneId: manifest?.winner_lane_id,
      winnerMode: manifest?.winner_mode,
      selectionSource: manifest?.selection_source,
      reason: manifest?.reason,
      error: manifest?.error,
    };
  } catch {
    return null;
  }
}

function loadRunSummaries(cwd: string): LabRunSummary[] {
  const projectName = basename(cwd);
  const scopedDirs: Array<{ scope: "local" | "global"; dir: string }> = [
    { scope: "local", dir: getProjectLabDir(cwd) },
    { scope: "global", dir: join(getGlobalLabDir(), projectName) },
  ];

  const runs: LabRunSummary[] = [];
  for (const scoped of scopedDirs) {
    if (!existsSync(scoped.dir)) continue;
    for (const entry of readdirSync(scoped.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "experiments") continue;
      const summary = readRunSummary(scoped.scope, join(scoped.dir, entry.name), entry.name);
      if (summary) runs.push(summary);
    }
  }

  runs.sort((a, b) => (b.timestamp ?? b.runId).localeCompare(a.timestamp ?? a.runId));
  return runs;
}

function formatRunChoiceLabel(run: LabRunSummary): string {
  const status = run.winnerLaneId ? `${run.winnerLaneId}` : run.stage ?? "unknown";
  const experiment = run.experimentId ?? "unknown-exp";
  return `[${run.scope}] ${run.runId} · ${experiment} · ${status}`;
}

function formatRunDetails(run: LabRunSummary): string {
  return [
    `Run: ${run.runId}`,
    `Scope: ${run.scope}`,
    `Path: ${run.dir}`,
    `Experiment: ${run.experimentId ?? "—"}`,
    `Timestamp: ${run.timestamp ?? "—"}`,
    `Stage: ${run.stage ?? "—"}`,
    `Winner: ${run.winnerLaneId ?? "—"}`,
    `Winner mode: ${run.winnerMode ?? "—"}`,
    `Selection source: ${run.selectionSource ?? "—"}`,
    run.reason ? `Reason: ${run.reason}` : undefined,
    run.error ? `Error: ${run.error}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

async function showRunsMenu(ctx: any) {
  const runs = loadRunSummaries(ctx.cwd);
  if (runs.length === 0) {
    ctx.ui.notify("No lab runs found for this project (local or global).", "warning");
    return;
  }

  while (true) {
    const scopeChoice = await ctx.ui.select("pi-lab runs", [
      `Recent local runs (${runs.filter((r) => r.scope === "local").length})`,
      `Recent global runs (${runs.filter((r) => r.scope === "global").length})`,
      `All recent runs (${runs.length})`,
    ]);
    if (!scopeChoice) return;

    const visibleRuns = scopeChoice.startsWith("Recent local")
      ? runs.filter((r) => r.scope === "local")
      : scopeChoice.startsWith("Recent global")
        ? runs.filter((r) => r.scope === "global")
        : runs;

    if (visibleRuns.length === 0) {
      ctx.ui.notify("No runs found for that scope.", "warning");
      continue;
    }

    const selectedLabel = await ctx.ui.select(
      "Select a run",
      visibleRuns.slice(0, 20).map(formatRunChoiceLabel),
    );
    if (!selectedLabel) continue;

    const selectedRun = visibleRuns.slice(0, 20).find((run) => formatRunChoiceLabel(run) === selectedLabel);
    if (!selectedRun) continue;
    ctx.ui.notify(formatRunDetails(selectedRun), selectedRun.error ? "warning" : "info");
  }
}

async function showMaintenanceMenu(ctx: any) {
  while (true) {
    const gcChoice = await ctx.ui.select("pi-lab maintenance", [
      "Delete old runs for this project (keep newest 10)",
      "Preview cleanup for this project",
      "Preview cleanup for all global projects",
    ]);
    if (!gcChoice) return;
    let result;
    if (gcChoice === "Preview cleanup for this project") {
      result = runAbGcCommand("", ctx.cwd);
    } else if (gcChoice === "Delete old runs for this project (keep newest 10)") {
      const confirmed = await ctx.ui.confirm("Delete old runs?", "This deletes old lab runs for the current project and keeps the newest 10.");
      if (!confirmed) continue;
      result = runAbGcCommand("--force", ctx.cwd);
    } else {
      result = runAbGcCommand("--all-projects", ctx.cwd);
    }
    ctx.ui.notify(result.message, result.level === "error" ? "error" : result.level === "warning" ? "warning" : "info");
  }
}

async function showLabsMenu(ctx: any, experimentDirs?: string[]) {
  while (true) {
    const choice = await ctx.ui.select("pi-lab", [
      "Experiments",
      "Runs",
      "Maintenance",
    ]);
    if (!choice) return;

    if (choice === "Experiments") {
      await showExperimentsManager(ctx, experimentDirs);
      continue;
    }

    if (choice === "Runs") {
      await showRunsMenu(ctx);
      continue;
    }

    if (choice === "Maintenance") {
      await showMaintenanceMenu(ctx);
    }
  }
}

function createAbConductorExtension(pi: ExtensionAPI, experimentDirs?: string[]) {
  const cooldownState = new Map<string, number>();
  const defaultEditToolRenderer = createEditTool(process.cwd());

  pi.on("session_start", (_event, ctx) => {
    const seenFixedArgsTools = new Set<string>();
    const allExperiments = loadExperiments(ctx.cwd, { experimentDirs })
      .filter((e) => e.experiment.enabled !== false)
      .filter((e) => (e.validation?.errors?.length ?? 0) === 0)
      .filter((e) => toolNameOf(e.experiment) !== "edit");

    const fixedArgsExperiments = allExperiments.filter(
      (e) => canonicalExecutionStrategy(executionStrategyOf(e.experiment)) === "fixed_args",
    );

    for (const loaded of fixedArgsExperiments) {
      const toolName = toolNameOf(loaded.experiment);
      if (!toolName || seenFixedArgsTools.has(toolName)) continue;
      seenFixedArgsTools.add(toolName);

      const existing = pi.getAllTools().find((t) => t.name === toolName);
      const support = resolveFixedArgsInterceptorSupport(toolName, ctx.cwd, existing as any, {
        description: loaded.experiment.tool?.description,
        parameters: loaded.experiment.tool?.parameters_schema,
      });

      if (!support.parameters) {
        ctx.ui.notify(support.error ?? `Skipping fixed_args interceptor for '${toolName}'.`, "error");
        continue;
      }

      if (support.warning) {
        ctx.ui.notify(support.warning, "warning");
      }

      pi.registerTool({
        name: toolName,
        label: existing?.name ?? toolName,
        description:
          support.description ??
          `AB fixed-args interceptor for '${toolName}'. Runs experiment lanes with identical tool args and returns the winning lane result.`,
        parameters: support.parameters,
        async execute(toolCallId, params, signal, onUpdate, execCtx) {
          return runFixedArgsToolExperiment(
            params as Record<string, unknown>,
            toolName,
            toolCallId,
            signal,
            onUpdate,
            execCtx,
            cooldownState,
            experimentDirs,
            support.nativeTool,
          );
        },
        renderResult(result, options, theme) {
          return renderAbToolResult(result, options, theme);
        },
      });

      ctx.ui.notify(`Registered fixed_args A/B interceptor: ${toolName}`, "info");
    }

    const seenProxyTools = new Set<string>();
    const proxyExperiments = allExperiments.filter((e) => {
      const strategy = canonicalExecutionStrategy(executionStrategyOf(e.experiment));
      return strategy === "lane_single_call" || strategy === "lane_multi_call";
    });

    for (const loaded of proxyExperiments) {
      const toolName = toolNameOf(loaded.experiment);
      if (!toolName || seenProxyTools.has(toolName) || seenFixedArgsTools.has(toolName)) continue;
      seenProxyTools.add(toolName);

      pi.registerTool({
        name: toolName,
        label: toolName,
        description:
          `AB proxy-flow starter for '${toolName}'. Call this with task/context/constraints; lanes run either lane_single_call (single tool call) or lane_multi_call (multi-step replanning).`,
        parameters: ReplanFlowParams,
        async execute(_toolCallId, params, signal, _onUpdate, execCtx) {
          try {
            return await runSingleCallFlowExperiment(params, toolName, signal, execCtx, cooldownState, experimentDirs);
          } catch (err: any) {
            const msg = err?.message ?? String(err);
            if (!msg.includes("No active lane_single_call experiment matched tool")) {
              throw err;
            }
          }

          return runMultiCallFlowExperiment(params, toolName, signal, execCtx, cooldownState, experimentDirs);
        },
        renderResult(result, options, theme) {
          return renderAbToolResult(result, options, theme);
        },
      });

      ctx.ui.notify(`Registered proxy A/B tool: ${toolName}`, "info");
    }
  });

  pi.registerCommand("lab", {
    description: "Manage pi-lab experiments and runs",
    handler: async (args, ctx) => {
      const cmd = (args ?? "").trim();

      if (!cmd) {
        if (ctx.hasUI) {
          await showLabsMenu(ctx, experimentDirs);
          return;
        }
        ctx.ui.notify("Usage: /lab (interactive) or /lab experiments | runs | maintenance", "warning");
        return;
      }

      if (cmd === "status" || cmd === "validate") {
        const experiments = loadExperiments(ctx.cwd, { experimentDirs });
        if (experiments.length === 0) {
          ctx.ui.notify("No A/B experiments found (global or project).", "warning");
          return;
        }

        if (cmd === "status") {
          const lines = experiments.map((e) => `• ${formatExperimentSummary(e)}`);
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        const lines: string[] = [];
        for (const e of experiments) {
          lines.push(`• ${formatExperimentSummary(e)}`);
          for (const err of e.validation?.errors ?? []) {
            lines.push(`  - ERROR: ${err}`);
          }
          for (const warn of e.validation?.warnings ?? []) {
            lines.push(`  - WARN: ${warn}`);
          }
        }

        const hasErrors = experiments.some((e) => (e.validation?.errors?.length ?? 0) > 0);
        ctx.ui.notify(lines.join("\n"), hasErrors ? "warning" : "info");
        return;
      }

      if (cmd === "experiments" || cmd.startsWith("experiments ")) {
        const experiments = loadExperiments(ctx.cwd, { experimentDirs });
        const rest = cmd.slice("experiments".length).trim();

        if (experiments.length === 0) {
          ctx.ui.notify("No A/B experiments found (global or project).", "warning");
          return;
        }

        if (!rest || rest === "list") {
          const local = experiments.filter((e) => e.source === "project");
          const global = experiments.filter((e) => e.source === "global");
          const other = experiments.filter((e) => e.source !== "project" && e.source !== "global");
          const lines: string[] = [];
          lines.push("Local experiments:");
          lines.push(...(local.length > 0 ? local.map(formatExperimentListLine) : ["• none"]));
          lines.push("", "Global experiments:");
          lines.push(...(global.length > 0 ? global.map(formatExperimentListLine) : ["• none"]));
          if (other.length > 0) {
            lines.push("", "Other experiment sources:");
            lines.push(...other.map(formatExperimentListLine));
          }
          lines.push("", "Usage: /lab experiments toggle <id> | on <id> | off <id>");
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        const [actionRaw, ...idParts] = rest.split(/\s+/).filter(Boolean);
        const action = (actionRaw ?? "").toLowerCase();
        const experimentId = idParts.join(" ").trim();
        if (!["toggle", "on", "off", "enable", "disable"].includes(action) || !experimentId) {
          ctx.ui.notify("Usage: /lab experiments [list] | toggle <id> | on <id> | off <id>", "warning");
          return;
        }

        const target = experiments.find((e) => e.experiment.id === experimentId);
        if (!target) {
          ctx.ui.notify(`Experiment '${experimentId}' not found.`, "warning");
          return;
        }
        if (target.source !== "project" && target.source !== "global") {
          ctx.ui.notify(`Experiment '${experimentId}' comes from ${target.source} and is read-only here.`, "warning");
          return;
        }

        const nextEnabled = action === "toggle"
          ? target.experiment.enabled === false
          : action === "on" || action === "enable";
        const result = setExperimentEnabled(target.path, target.experiment.id, nextEnabled);
        if (!result.found) {
          ctx.ui.notify(`Experiment '${experimentId}' was not found in ${target.path}.`, "error");
          return;
        }

        ctx.ui.notify(`Experiment '${experimentId}' is now ${result.enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }

      if (cmd === "runs") {
        await showRunsMenu(ctx);
        return;
      }

      if (cmd === "maintenance") {
        await showMaintenanceMenu(ctx);
        return;
      }

      if (cmd === "gc" || cmd.startsWith("gc ")) {
        const result = runAbGcCommand(cmd.slice(2).trim(), ctx.cwd);
        ctx.ui.notify(result.message, result.level === "error" ? "error" : result.level === "warning" ? "warning" : "info");
        return;
      }

      ctx.ui.notify("Usage: /lab experiments | runs | maintenance", "warning");
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Edit a file by replacing exact text. A/B conductor intercepts this call when configured experiments match trigger policy.",
    parameters: EditParams,
    renderResult(result, options, theme) {
      return renderAbToolResult(result, options, theme, (innerResult, innerOptions, innerTheme) => {
        if (typeof defaultEditToolRenderer.renderResult === "function") {
          return defaultEditToolRenderer.renderResult(innerResult, innerOptions as any, innerTheme);
        }
        return new Text(String(innerResult?.content?.[0]?.type === "text" ? innerResult.content[0].text : "Done."), 0, 0);
      });
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const nativeEdit = createEditTool(ctx.cwd);

      if (process.env.PI_AB_LANE === "1" || process.env.PI_AB_GRADER === "1") {
        return nativeEdit.execute(toolCallId, params, signal, onUpdate);
      }

      const now = Date.now();
      const loaded = selectExperimentForEdit(ctx.cwd, params, now, cooldownState, { experimentDirs });
      if (!loaded) {
        return nativeEdit.execute(toolCallId, params, signal, onUpdate);
      }

      const experiment = loaded.experiment;
      cooldownState.set(experiment.id, now);

      const run = createRunContext(ctx.cwd, loaded.source);
      writeRunManifest(run, experiment, {
        source: loaded.source,
        config_path: loaded.path,
        configured_winner_mode: winnerModeOf(experiment),
        intercepted_tool: "edit",
        intercepted_args: { path: params.path, oldText_len: params.oldText.length, newText_len: params.newText.length },
        execution_strategy: canonicalExecutionStrategy(executionStrategyOf(experiment)),
        lane_harness: process.env.PI_AB_LANE_HARNESS ?? inferLaneHarness(executionStrategyOf(experiment)),
        stage: "started",
      });

      const policy = defaultPolicy(experiment);
      const laneStatusKey = "ab-lanes";
      const gitRepo = await detectGitRepository(ctx.cwd, signal);

      if (!gitRepo.ok) {
        const warning = nonGitBaselineFallbackMessage(gitRepo.error);
        ctx.ui.notify(warning, "warning");

        const fallback = await runBaselineEditFallbackNoGit(
          loaded,
          run,
          ctx.cwd,
          { path: params.path, oldText: params.oldText, newText: params.newText },
          signal,
        );
        const lanes = [fallback.lane];
        writeLaneRecords(run, lanes);
        writeRunManifest(run, experiment, {
          ...summarizeLaneFailures(lanes),
          stage: fallback.lane.status === "success" ? "completed_fallback_baseline" : "failed",
          error: gitRepo.error,
          reason: warning,
          winner_lane_id: fallback.lane.status === "success" ? fallback.lane.lane_id : undefined,
          winner_mode: fallback.lane.status === "success" ? "baseline-no-git-fallback" : undefined,
          selection_source: fallback.lane.status === "success" ? "baseline_no_git_fallback" : undefined,
          fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
        });

        if (fallback.lane.status !== "success") {
          throw new Error(`Baseline lane failed while running outside a git repo: ${fallback.lane.error ?? "unknown error"}`);
        }

        const summaryMarkdown = buildExperimentSummaryMarkdown(
          experiment.id,
          lanes,
          {
            winner_lane_id: fallback.lane.lane_id,
            winner_mode: "baseline-no-git-fallback",
            selection_source: "baseline_no_git_fallback",
            fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
          },
          run.dir,
        );

        return {
          content: [{ type: "text", text: combineToolTextWithSummary(fallback.lane.output_text ?? `Successfully replaced text in ${params.path}.`, summaryMarkdown) }],
          details: {
            ...(fallback.patchText ? { diff: fallback.patchText, firstChangedLine: undefined } : {}),
            ab: {
              run_id: run.runId,
              experiment_id: experiment.id,
              winner_lane_id: fallback.lane.lane_id,
              winner_mode: "baseline-no-git-fallback",
              selection_source: "baseline_no_git_fallback",
              fallback_reason_code: NON_GIT_BASELINE_FALLBACK_REASON,
              no_git: true,
              summary_markdown: summaryMarkdown,
            },
          },
        };
      }

      try {
        const lanes = await runExperimentLanes(
          loaded,
          run,
          ctx.cwd,
          ctx.sessionManager.getSessionFile(),
          { path: params.path, oldText: params.oldText, newText: params.newText },
          signal,
          (snapshot) => {
            updateLaneWidget(ctx, laneStatusKey, experiment.id, snapshot);
          },
        );

        writeLaneRecords(run, lanes);
        writeRunManifest(run, experiment, {
          ...summarizeLaneFailures(lanes),
        });

        const winner = await selectWinner(
          loaded,
          run,
          ctx.cwd,
          lanes,
          {
            intercepted_tool: "edit",
            intercepted_args: {
              path: params.path,
              oldText_len: params.oldText.length,
              newText_len: params.newText.length,
            },
          },
          ctx.model,
          signal,
        );

        const selected = laneById(lanes, winner.winner_lane_id);
        if (!selected || !selected.patch_path || (selected.patch_bytes ?? 0) <= 0) {
          throw new Error(`Winner lane ${winner.winner_lane_id} has no patch.`);
        }

        const apply = await applyPatchToMain(ctx.cwd, selected.patch_path, signal);
        if (!apply.ok) {
          if (policy.on_winner_apply_failure === "fallback_baseline_then_fail") {
            const baseline = laneById(lanes, getBaselineLaneId(experiment));
            if (baseline?.patch_path && baseline.patch_path !== selected.patch_path) {
              const fallbackApply = await applyPatchToMain(ctx.cwd, baseline.patch_path, signal);
              if (fallbackApply.ok) {
                const patch = readFileSync(baseline.patch_path, "utf8");
                writeRunManifest(run, experiment, {
                  stage: "completed",
                  winner_lane_id: baseline.lane_id,
                  winner_mode: `${winner.mode_used} + baseline-apply-fallback`,
                  reason: `${winner.reason}; winner apply failed, baseline patch applied`,
                  selection_source: "baseline_apply_fallback",
                  fallback_reason_code: "winner_apply_failed_baseline_apply_succeeded",
                  llm_error_code: winner.llm_error_code,
                });

                const summaryMarkdown = buildExperimentSummaryMarkdown(
                  experiment.id,
                  lanes,
                  {
                    winner_lane_id: baseline.lane_id,
                    winner_mode: `${winner.mode_used} + baseline-apply-fallback`,
                    reason: `${winner.reason}; winner apply failed, baseline patch applied`,
                    selection_source: "baseline_apply_fallback",
                    fallback_reason_code: "winner_apply_failed_baseline_apply_succeeded",
                    llm_error: winner.llm_error,
                    llm_error_code: winner.llm_error_code,
                  },
                  run.dir,
                );

                return {
                  content: [{ type: "text", text: combineToolTextWithSummary(baseline.output_text ?? `Successfully replaced text in ${params.path}.`, summaryMarkdown) }],
                  details: {
                    diff: patch,
                    firstChangedLine: undefined,
                    ab: {
                      run_id: run.runId,
                      experiment_id: experiment.id,
                      winner_lane_id: baseline.lane_id,
                      winner_mode: winner.mode_used,
                      selection_source: "baseline_apply_fallback",
                      fallback_applied: true,
                      fallback_reason_code: "winner_apply_failed_baseline_apply_succeeded",
                      llm_error_code: winner.llm_error_code,
                      summary_markdown: summaryMarkdown,
                    },
                  },
                };
              }
            }
          }

          throw new Error(`Winner patch apply failed: ${apply.error ?? "unknown error"}`);
        }

        const patch = readFileSync(selected.patch_path, "utf8");
        writeRunManifest(run, experiment, {
          stage: "completed",
          winner_lane_id: selected.lane_id,
          winner_mode: winner.mode_used,
          reason: winner.reason,
          selection_source: winner.selection_source,
          fallback_reason_code: winner.fallback_reason_code,
          llm_error_code: winner.llm_error_code,
        });

        const summaryMarkdown = buildExperimentSummaryMarkdown(
          experiment.id,
          lanes,
          {
            winner_lane_id: selected.lane_id,
            winner_mode: winner.mode_used,
            reason: winner.reason,
            selection_source: winner.selection_source,
            fallback_reason_code: winner.fallback_reason_code,
            llm_error: winner.llm_error,
            llm_error_code: winner.llm_error_code,
          },
          run.dir,
        );

        return {
          content: [{ type: "text", text: combineToolTextWithSummary(selected.output_text ?? `Successfully replaced text in ${params.path}.`, summaryMarkdown) }],
          details: {
            diff: patch,
            firstChangedLine: undefined,
            ab: {
              run_id: run.runId,
              experiment_id: experiment.id,
              winner_lane_id: selected.lane_id,
              winner_mode: winner.mode_used,
              selection_source: winner.selection_source,
              fallback_reason_code: winner.fallback_reason_code,
              llm_error: winner.llm_error,
              llm_error_code: winner.llm_error_code,
              summary_markdown: summaryMarkdown,
            },
          },
        };
      } catch (err: any) {
        const errorText = err?.message ?? String(err);

        if (policy.all_lanes_failed === "fallback_baseline") {
          try {
            const nativeFallback = await nativeEdit.execute(toolCallId, params, signal, onUpdate);
            writeRunManifest(run, experiment, {
              stage: "completed_fallback_native",
              error: errorText,
              reason: "lane orchestration failed; native edit fallback",
              selection_source: "native_fallback",
              fallback_reason_code: "lane_orchestration_failed_native_fallback",
            });
            return {
              content: nativeFallback.content,
              details: {
                ...(nativeFallback as any).details,
                ab: {
                  run_id: run.runId,
                  experiment_id: experiment.id,
                  configured_winner_mode: winnerModeOf(experiment),
                  selection_source: "native_fallback",
                  fallback_native: true,
                  fallback_reason_code: "lane_orchestration_failed_native_fallback",
                  error: errorText,
                },
              },
            };
          } catch (nativeErr: any) {
            const nativeErrorText = nativeErr?.message ?? String(nativeErr);
            writeRunManifest(run, experiment, {
              stage: "failed",
              error: `${errorText}; native fallback failed: ${nativeErrorText}`,
              fallback_reason_code: "native_fallback_failed",
            });
            throw nativeErr;
          }
        }

        writeRunManifest(run, experiment, {
          stage: "failed",
          error: errorText,
          fallback_reason_code: "ab_failed_no_fallback",
        });
        throw err;
      } finally {
        updateLaneWidget(ctx, laneStatusKey, experiment.id, undefined);
        pruneEmptyRunScaffolding(run);
      }
    },
  });
}

export function createAbExtension(options: AbExtensionOptions = {}): (pi: ExtensionAPI) => void {
  const experimentDirs = resolveExperimentDirs(options.experimentDirs, options.baseDir);
  return (pi) => createAbConductorExtension(pi, experimentDirs);
}

export default createAbExtension();
