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
  keyHint,
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
  deactivateBuiltinToolsOf,
  executionStrategyOf,
  formatExperimentSummary,
  formulaConfigOf,
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
import { runLabGcCommand } from "./gc.ts";
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

const InterceptableEditParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute)" })),
  oldText: Type.Optional(Type.String({ description: "Exact text to find and replace (must match exactly)" })),
  newText: Type.Optional(Type.String({ description: "New text to replace the old text with" })),
  task: Type.Optional(Type.String({ description: "Goal for this flow. Lanes may have different concrete APIs and will replan." })),
  context: Type.Optional(Type.String({ description: "Optional context for the flow" })),
  constraints: Type.Optional(Type.String({ description: "Optional constraints/instructions" })),
});

function isExactEditInput(params: any): params is { path: string; oldText: string; newText: string } {
  return typeof params?.path === "string" && typeof params?.oldText === "string" && typeof params?.newText === "string";
}

function isReplanFlowInput(params: any): params is { task: string; context?: string; constraints?: string } {
  return typeof params?.task === "string";
}

export interface LabExtensionOptions {
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
      lane.tool_call_count != null ? `${lane.tool_call_count} calls` : undefined,
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
  scores?: Array<{ lane_id: string; score: number; reason?: string }>;
};

type ExperimentGradingSummary = {
  winner_lane_id: string;
  scores?: Array<{ lane_id: string; score: number; reason?: string }>;
  confidence?: number;
  tie_break_used?: string;
  notes?: string;
};

const FORMULA_PLACEHOLDER_KEYS = [
  "success",
  "timeout",
  "error",
  "latency_ms",
  "total_tokens",
  "tool_call_count",
  "total_tool_call_count",
  "target_tool_call_count",
  "custom_tool_call_count",
  "patch_bytes",
  "process_exit_code",
] as const;

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

function formulaPlaceholderValue(lane: LaneRunRecord, key: typeof FORMULA_PLACEHOLDER_KEYS[number]): number | undefined {
  switch (key) {
    case "success":
      return lane.status === "success" ? 1 : 0;
    case "timeout":
      return lane.status === "timeout" ? 1 : 0;
    case "error":
      return lane.status === "error" ? 1 : 0;
    case "latency_ms":
      return lane.latency_ms;
    case "total_tokens":
      return lane.total_tokens;
    case "tool_call_count":
      return lane.tool_call_count ?? lane.total_tool_call_count;
    case "total_tool_call_count":
      return lane.total_tool_call_count ?? lane.tool_call_count;
    case "target_tool_call_count":
      return lane.target_tool_call_count;
    case "custom_tool_call_count":
      return lane.custom_tool_call_count;
    case "patch_bytes":
      return lane.patch_bytes;
    case "process_exit_code":
      return lane.process_exit_code;
  }
}

function evaluateFormulaTemplate(template: string | undefined, lane: LaneRunRecord): number | undefined {
  const trimmed = template?.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^(min|max)\((.*)\)$/i);
  const body = match?.[2]?.trim() || trimmed;
  if (!body) return undefined;

  const substituted = body.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_full, key: string) => {
    if (!FORMULA_PLACEHOLDER_KEYS.includes(key as typeof FORMULA_PLACEHOLDER_KEYS[number])) return "(0/0)";
    const value = formulaPlaceholderValue(lane, key as typeof FORMULA_PLACEHOLDER_KEYS[number]);
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "(0/0)";
  });

  if (substituted.includes("**") || !/^[0-9+\-*/().\s]+$/.test(substituted)) return undefined;

  try {
    const value = Function(`"use strict"; return (${substituted});`)();
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function buildExperimentSummaryMarkdown(
  experiment: { id: string; winner?: { formula?: { objective?: string; tie_breakers?: string[] } } },
  lanes: LaneRunRecord[],
  winner: ExperimentWinnerSummary,
  runDir: string,
): string {
  const formula = formulaConfigOf(experiment as any);
  const objectiveTemplate = formula.objective ?? "min(latency_ms)";
  const tieBreakerTemplates = formula.tie_breakers ?? [];

  const lines = [
    `### pi-lab summary · ${experiment.id}`,
    "",
    "| Lane | Status | Latency ms | Tool calls | Tokens | Patch bytes | Model | Harness | Exit | Error |",
    "|---|---|---:|---:|---:|---:|---|---|---:|---|",
    ...lanes.map((lane) => {
      const harness = lane.lane_harness_used ?? lane.lane_harness_requested;
      return `| ${mdCell(lane.lane_id)} | ${mdCell(lane.status)} | ${mdCell(lane.latency_ms)} | ${mdCell(lane.tool_call_count ?? lane.total_tool_call_count)} | ${mdCell(lane.total_tokens)} | ${mdCell(lane.patch_bytes)} | ${mdCell(lane.lane_model)} | ${mdCell(harness)} | ${mdCell(lane.process_exit_code)} | ${mdCell(lane.error)} |`;
    }),
    "",
    `**Winner:** \`${winner.winner_lane_id}\` via \`${winner.winner_mode}\``,
  ];

  if (winner.reason) lines.push(`**Reason:** ${winner.reason}`);
  if (winner.selection_source) lines.push(`**Selection source:** \`${winner.selection_source}\``);
  if (winner.fallback_reason_code) lines.push(`**Fallback reason:** \`${winner.fallback_reason_code}\``);

  if (winner.scores?.length) {
    const scoreLine = winner.scores
      .map((item) => `\`${item.lane_id}: ${item.score.toFixed(3)}\``)
      .join(" ");
    lines.push(`**Scores:** ${scoreLine}`);
  }

  const objectiveValues = lanes
    .map((lane) => {
      const value = evaluateFormulaTemplate(objectiveTemplate, lane);
      return `\`${lane.lane_id}: ${typeof value === "number" ? value.toFixed(3) : "—"}\``;
    })
    .join(" ");

  lines.push(
    "",
    "#### Formula placeholders",
    "",
    `**Objective template:** \`${objectiveTemplate}\``,
    tieBreakerTemplates.length > 0 ? `**Tie-breakers:** ${tieBreakerTemplates.map((item) => `\`${item}\``).join(" → ")}` : "",
    `**Objective values:** ${objectiveValues}`,
    "",
    "| Lane | Status | success | timeout | error | latency_ms | total_tokens | tool_call_count | total_tool_call_count | target_tool_call_count | custom_tool_call_count | patch_bytes | process_exit_code | objective_value |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...lanes.map((lane) => {
      const objectiveValue = evaluateFormulaTemplate(objectiveTemplate, lane);
      return `| ${mdCell(lane.lane_id)} | ${mdCell(lane.status)} | ${mdCell(formulaPlaceholderValue(lane, "success"))} | ${mdCell(formulaPlaceholderValue(lane, "timeout"))} | ${mdCell(formulaPlaceholderValue(lane, "error"))} | ${mdCell(formulaPlaceholderValue(lane, "latency_ms"))} | ${mdCell(formulaPlaceholderValue(lane, "total_tokens"))} | ${mdCell(formulaPlaceholderValue(lane, "tool_call_count"))} | ${mdCell(formulaPlaceholderValue(lane, "total_tool_call_count"))} | ${mdCell(formulaPlaceholderValue(lane, "target_tool_call_count"))} | ${mdCell(formulaPlaceholderValue(lane, "custom_tool_call_count"))} | ${mdCell(formulaPlaceholderValue(lane, "patch_bytes"))} | ${mdCell(formulaPlaceholderValue(lane, "process_exit_code"))} | ${mdCell(typeof objectiveValue === "number" ? objectiveValue.toFixed(3) : undefined)} |`;
    }),
  );

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
  tool_calls: string;
  tokens: string;
  patch_bytes: string;
  model: string;
  harness: string;
  exit: string;
  error: string;
};

type ParsedMarkdownTable = {
  headers: string[];
  rows: string[][];
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
    if (line.startsWith("| Lane | Status | Latency ms | Tool calls | Tokens | Patch bytes | Model | Harness | Exit | Error |")) {
      inLaneTable = true;
      continue;
    }
    if (!inLaneTable) continue;
    const cells = parseMarkdownTableCells(line);
    if (!cells) {
      if (line.trim()) inLaneTable = false;
      continue;
    }
    if (cells.length !== 10 || cells[0] === "Lane") continue;
    rows.push({
      lane_id: cells[0] ?? "—",
      status: cells[1] ?? "—",
      latency_ms: cells[2] ?? "—",
      tool_calls: cells[3] ?? "—",
      tokens: cells[4] ?? "—",
      patch_bytes: cells[5] ?? "—",
      model: cells[6] ?? "—",
      harness: cells[7] ?? "—",
      exit: cells[8] ?? "—",
      error: cells[9] ?? "—",
    });
  }

  return rows;
}

function parseSummaryValue(summaryMarkdown: string, label: string): string | undefined {
  const line = summaryMarkdown.split("\n").find((entry) => entry.startsWith(label));
  if (!line) return undefined;
  return stripSimpleMarkdown(line.slice(label.length).trim());
}

function parseMarkdownTable(summaryMarkdown: string, headerLinePrefix: string): ParsedMarkdownTable | undefined {
  const lines = summaryMarkdown.split("\n");
  const headerIndex = lines.findIndex((line) => line.startsWith(headerLinePrefix));
  if (headerIndex < 0) return undefined;

  const headers = parseMarkdownTableCells(lines[headerIndex] ?? "");
  if (!headers || headers.length === 0) return undefined;

  const rows: string[][] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\|[-:| ]+\|$/.test(trimmed)) continue;

    const cells = parseMarkdownTableCells(line);
    if (!cells) break;
    if (cells.length === headers.length && cells[0] !== headers[0]) {
      rows.push(cells);
      continue;
    }
    break;
  }

  return { headers, rows };
}

function renderTableAsLines(table: ParsedMarkdownTable): string {
  return table.rows
    .map((row) => {
      const label = row[0] ?? "item";
      const parts = table.headers
        .slice(1)
        .map((header, index) => ({ header, value: row[index + 1] ?? "—" }))
        .filter((entry) => entry.value && entry.value !== "—")
        .map((entry) => `${entry.header.toLowerCase()}: ${entry.value}`);
      return parts.length > 0 ? `${label} — ${parts.join(" · ")}` : label;
    })
    .join("\n");
}

function renderSectionTitle(theme: any, title: string): string {
  return theme.fg("accent", title);
}

function renderLabToolResult(
  result: any,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: any,
  fallback?: (result: any, options: { expanded?: boolean; isPartial?: boolean }, theme: any) => any,
) {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "pi-lab running lanes..."), 0, 0);
  }

  const lab = result?.details?.lab as { summary_markdown?: string; experiment_id?: string; winner_lane_id?: string; winner_mode?: string } | undefined;
  const summaryMarkdown = lab?.summary_markdown;
  const baseText = String(result?.content?.[0]?.type === "text" ? result.content[0].text : "Done.").trim();
  if (!summaryMarkdown) {
    return fallback ? fallback(result, options, theme) : new Text(baseText, 0, 0);
  }

  const rows = parseSummaryRows(summaryMarkdown);
  const reason = parseSummaryValue(summaryMarkdown, "**Reason:**");
  const selectionSource = parseSummaryValue(summaryMarkdown, "**Selection source:**");
  const scores = parseSummaryValue(summaryMarkdown, "**Scores:**");
  const objectiveTemplate = parseSummaryValue(summaryMarkdown, "**Objective template:**");
  const objectiveValues = parseSummaryValue(summaryMarkdown, "**Objective values:**");
  const tieBreakers = parseSummaryValue(summaryMarkdown, "**Tie-breakers:**");
  const llmWinner = parseSummaryValue(summaryMarkdown, "**LLM winner:**");
  const confidence = parseSummaryValue(summaryMarkdown, "**Confidence:**");
  const tieBreak = parseSummaryValue(summaryMarkdown, "**Tie break used:**");
  const notes = parseSummaryValue(summaryMarkdown, "**Notes:**");
  const laneTable = parseMarkdownTable(summaryMarkdown, "| Lane | Status | Latency ms | Tool calls | Tokens | Patch bytes | Model | Harness | Exit | Error |");
  const formulaTable = parseMarkdownTable(summaryMarkdown, "| Lane | Status | success | timeout | error | latency_ms | total_tokens | tool_call_count | total_tool_call_count");
  const llmTable = parseMarkdownTable(summaryMarkdown, "| Lane | Score | Reason |");

  let text = "";
  const hasBaseText = baseText && baseText !== "Done.";
  if (hasBaseText) {
    text += `\n${baseText}`;
  }
  text += `${hasBaseText ? "\n\n" : "\n"}${theme.fg("accent", `pi-lab summary · ${lab?.experiment_id ?? "experiment"}`)}`;
  text += `\n${theme.fg("success", `winner ${lab?.winner_lane_id ?? "—"}`)}${theme.fg("dim", ` via ${lab?.winner_mode ?? "—"}`)}`;
  if (selectionSource && selectionSource !== lab?.winner_mode) {
    text += `\n${theme.fg("dim", `selection source: ${selectionSource}`)}`;
  }
  if (reason) {
    text += `\n${theme.fg("dim", reason)}`;
  }

  for (const row of rows) {
    const statusColor = row.status === "success" ? "success" : row.status === "timeout" ? "warning" : row.status === "error" ? "error" : "muted";
    const latency = row.latency_ms !== "—" ? ` · ${row.latency_ms}ms` : "";
    const toolCalls = row.tool_calls !== "—" ? ` · ${row.tool_calls} calls` : "";
    const patch = row.patch_bytes !== "—" ? ` · patch ${row.patch_bytes}B` : "";
    const model = row.model !== "—" ? ` · model ${row.model}` : "";
    const harness = row.harness !== "—" ? ` · ${row.harness}` : "";
    const exit = row.exit !== "—" ? ` · exit ${row.exit}` : "";
    text += `\n${theme.fg(statusColor, `${row.status === "success" ? "✓" : row.status === "timeout" ? "⏱" : row.status === "error" ? "✗" : "○"} ${row.lane_id}`)}${theme.fg("dim", `${latency}${toolCalls}${patch}${model}${harness}${exit}`)}`;
    if (row.error && row.error !== "—") {
      text += `\n${theme.fg("error", `  ${row.error}`)}`;
    }
  }

  if (scores) {
    text += `\n${theme.fg("muted", `scores ${scores}`)}`;
  }
  if (objectiveValues) {
    text += `\n${theme.fg("muted", `objective ${objectiveValues}`)}`;
  }

  if (llmWinner || confidence || tieBreak) {
    const parts = [llmWinner ? `llm ${llmWinner}` : undefined, confidence ? `confidence ${confidence}` : undefined, tieBreak ? `tie ${tieBreak}` : undefined].filter(Boolean);
    if (parts.length > 0) text += `\n${theme.fg("muted", parts.join(" · "))}`;
  }

  if (!options.expanded) {
    text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
  }

  if (options.expanded) {
    if (laneTable?.rows.length) {
      text += `\n\n${renderSectionTitle(theme, "lane details")}`;
      text += `\n${renderTableAsLines(laneTable)}`;
    }

    if (objectiveTemplate || tieBreakers || objectiveValues || formulaTable?.rows.length) {
      text += `\n\n${renderSectionTitle(theme, "formula placeholders")}`;
      if (objectiveTemplate) text += `\n${theme.fg("muted", `objective template: ${objectiveTemplate}`)}`;
      if (tieBreakers) text += `\n${theme.fg("muted", `tie-breakers: ${tieBreakers}`)}`;
      if (objectiveValues) text += `\n${theme.fg("muted", `objective values: ${objectiveValues}`)}`;
      if (formulaTable?.rows.length) {
        text += `\n${renderTableAsLines(formulaTable)}`;
      }
    }

    if (llmWinner || confidence || tieBreak || llmTable?.rows.length || notes) {
      text += `\n\n${renderSectionTitle(theme, "llm grading")}`;
      if (llmWinner) text += `\n${theme.fg("muted", `winner: ${llmWinner}`)}`;
      if (confidence) text += `\n${theme.fg("muted", `confidence: ${confidence}`)}`;
      if (tieBreak) text += `\n${theme.fg("muted", `tie break used: ${tieBreak}`)}`;
      if (llmTable?.rows.length) {
        text += `\n${renderTableAsLines(llmTable)}`;
      }
      if (notes) {
        text += `\n${theme.fg("muted", `notes: ${notes}`)}`;
      }
    }
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
    `Lab fixed-args interceptor for '${toolName}'. Runs experiment lanes with identical tool args and returns the winning lane result.`;
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

function proxyToolDescription(toolName: string, configuredDescription?: string): string {
  return configuredDescription?.trim() ||
    `Lab proxy-flow starter for '${toolName}'. Call this with task/context/constraints; lanes run either lane_single_call (single tool call) or lane_multi_call (multi-step replanning).`;
}

function proxyToolPromptSnippet(toolName: string, configuredDescription?: string): string {
  return configuredDescription?.trim() || `Use ${toolName} for this project's proxy-flow experiment tasks`;
}

function proxyToolPromptGuidelines(toolName: string, configuredDescription?: string): string[] {
  const guidelines: string[] = [];
  const trimmedDescription = configuredDescription?.trim();
  if (trimmedDescription) guidelines.push(trimmedDescription);

  if (toolName.toLowerCase().includes("edit")) {
    guidelines.push(
      `When you want to edit files in this experiment, use '${toolName}' directly. Do not fall back to the built-in 'edit' tool, 'write', or bash rewrites unless the user explicitly asks.`,
    );
  } else {
    guidelines.push(
      `When this project expects '${toolName}', call the '${toolName}' tool directly instead of trying to emulate it with other tools.`,
    );
  }

  guidelines.push(`'${toolName}' accepts a task plus optional context/constraints and will route the request through pi-lab experiment lanes.`);
  return guidelines;
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
    lane_harness: process.env.PI_LAB_LANE_HARNESS ?? inferLaneHarness(executionStrategyOf(experiment)),
    trigger_bypassed: triggerBypassed || undefined,
    trigger_bypass_reason: triggerBypassed ? "no_native_delegate_for_nonmatching_trigger" : undefined,
    stage: "started",
  });

  const laneStatusKey = "lab-lanes";
  const gitRepo = await detectGitRepository(ctx.cwd, signal);

  if (!gitRepo.ok) {
    const warning = nonGitBaselineFallbackMessage(gitRepo.error);
    ctx.ui.notify(warning, "warning");

    const fallback = await runBaselineFixedArgsFallbackNoGit(loaded, run, ctx.cwd, toolName, params, signal, ctx.model, pi.getThinkingLevel());
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
      experiment,
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
        lab: {
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
      ctx.model,
      pi.getThinkingLevel(),
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
      experiment,
      lanes,
      {
        winner_lane_id: returnedLane.lane_id,
        winner_mode: returnedWinnerMode,
        reason: winner.reason,
        scores: winner.scores,
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
        lab: {
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

  const laneStatusKey = "lab-lanes";
  const gitRepo = await detectGitRepository(ctx.cwd, signal);

  if (!gitRepo.ok) {
    const warning = nonGitBaselineFallbackMessage(gitRepo.error);
    ctx.ui.notify(warning, "warning");

    const fallback = await runBaselineSingleCallFallbackNoGit(loaded, run, ctx.cwd, toolName, params, signal, ctx.model, pi.getThinkingLevel());
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
      experiment,
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
        lab: {
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
      pi.getThinkingLevel(),
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
      experiment,
      lanes,
      {
        winner_lane_id: selected.lane_id,
        winner_mode: winner.mode_used,
        reason: winner.reason,
        scores: winner.scores,
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
        lab: {
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

  const laneStatusKey = "lab-lanes";
  const gitRepo = await detectGitRepository(ctx.cwd, signal);

  if (!gitRepo.ok) {
    const warning = nonGitBaselineFallbackMessage(gitRepo.error);
    ctx.ui.notify(warning, "warning");

    const fallback = await runBaselineMultiCallFallbackNoGit(loaded, run, ctx.cwd, toolName, params, signal, ctx.model, pi.getThinkingLevel());
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
      experiment,
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
        lab: {
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
      pi.getThinkingLevel(),
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
      experiment,
      lanes,
      {
        winner_lane_id: returnedLane.lane_id,
        winner_mode: returnedWinnerMode,
        reason: fallbackApplied ? `${winner.reason}; winner apply failed, baseline patch applied` : winner.reason,
        scores: winner.scores,
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
        lab: {
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

async function showExistingExperimentsManager(ctx: any, experimentDirs?: string[]) {
  const experiments = loadExperiments(ctx.cwd, { experimentDirs });
  if (experiments.length === 0) {
    ctx.ui.notify("No lab experiments found (global or project).", "warning");
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

async function showExperimentsManager(pi: ExtensionAPI, ctx: any, experimentDirs?: string[]) {
  while (true) {
    const choice = await ctx.ui.select("pi-lab experiments", [
      "Create experiment",
      "Manage existing experiments",
    ]);
    if (!choice) return;

    if (choice === "Create experiment") {
      await startCreateExperimentConversation(pi, ctx);
      continue;
    }

    await showExistingExperimentsManager(ctx, experimentDirs);
  }
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
      result = runLabGcCommand("", ctx.cwd);
    } else if (gcChoice === "Delete old runs for this project (keep newest 10)") {
      const confirmed = await ctx.ui.confirm("Delete old runs?", "This deletes old lab runs for the current project and keeps the newest 10.");
      if (!confirmed) continue;
      result = runLabGcCommand("--force", ctx.cwd);
    } else {
      result = runLabGcCommand("--all-projects", ctx.cwd);
    }
    ctx.ui.notify(result.message, result.level === "error" ? "error" : result.level === "warning" ? "warning" : "info");
  }
}

type LabToolInspection = {
  name: string;
  required: string[];
  optional: string[];
};

function parseRequestedTargets(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function summarizeToolSchema(tool: any): { required: string[]; optional: string[] } {
  const schema = tool?.parameters as any;
  const properties = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((value: unknown) => typeof value === "string")
    : [];
  const keys = Object.keys(properties);
  const optional = keys.filter((key) => !required.includes(key));
  return { required, optional };
}

function inspectRequestedTools(pi: ExtensionAPI, rawTargets: string): LabToolInspection[] {
  const requested = parseRequestedTargets(rawTargets);
  const tools = pi.getAllTools();
  const inspections: LabToolInspection[] = [];

  for (const target of requested) {
    const normalized = target.replace(/^\//, "");
    const match = tools.find((tool) => tool.name === normalized);
    if (!match) continue;
    const schema = summarizeToolSchema(match);
    inspections.push({
      name: match.name,
      required: schema.required,
      optional: schema.optional,
    });
  }

  return inspections;
}

function buildLabCreateKickoff(pi: ExtensionAPI, ctx: any, initialTargets?: string): string {
  const compareTargets = initialTargets?.trim();
  const inspections = compareTargets ? inspectRequestedTools(pi, compareTargets) : [];
  const lines = [
    "Help me set up a pi-lab experiment for this project.",
    "",
    "Please handle this as a normal conversation, not as a separate wizard.",
    "Ask me only the necessary follow-up questions in chat, inspect the relevant tools/extensions/files, recommend the right strategy, and then create the experiment once you have enough information.",
    "",
    "Requirements for the setup flow:",
    "- ask what tools/extensions should be compared",
    "- ask what behavior or outcome should be tested",
    "- ask what should count as success",
    "- ask whether this should be project-local or global if that is still unclear",
    "- ask about lane files, prompts, experiment assets, and whether candidate lanes already exist",
    "- inspect the real tool/input shape before recommending fixed_args vs lane_single_call vs lane_multi_call",
    "- inspect whether the target is a builtin tool and make this a required decision point: ask whether the user wants a transparent same-name replacement or an explicit lab-only proxy tool name",
    "- for builtin targets, default to additive mode unless the user explicitly asks for transparent replacement under the builtin name",
    "- if the user wants normal requests to naturally use the replacement, keep the replacement under the builtin name (for example `edit`) instead of inventing a differently named proxy (for example `edit_experiment`)",
    "- if builtin replacement discoverability matters, create or recommend a companion custom extension that blocks or redirects builtin behavior as needed, says the builtin tool is not directly available, points the agent to the replacement under the same name, and adds any needed guardrails",
    "- use deactivate_builtin_tools when the builtin should disappear from the main session's active tool list, but note that this alone does not add prompt guidance or fallback blocking",
    "- recommend winner mode only after understanding whether this is about metrics, semantic quality, or both",
    "- create the experiment once the missing information is resolved",
    "- explain what you created and how to run or inspect it afterward",
    "",
    "Defaults to prefer unless I say otherwise:",
    "- prefer project-local experiments in .pi/lab/experiments/*.json",
    "- keep one clear baseline/fallback lane",
    "- for builtin targets, default to additive mode rather than replacing the builtin tool name unless I explicitly ask for transparent replacement",
    "- when builtin replacement is explicitly requested because the replacement should feel like normal usage, prefer the builtin name itself",
    "- do not ask unnecessary config-level questions up front",
  ];

  if (compareTargets) {
    lines.push("", `Initial compare target(s): ${compareTargets}`);
  }

  if (inspections.length > 0) {
    lines.push("", "Registered tool matches seen right now:");
    for (const inspection of inspections) {
      const required = inspection.required.length > 0 ? inspection.required.join(", ") : "none";
      const optional = inspection.optional.length > 0 ? inspection.optional.join(", ") : "none";
      lines.push(`- ${inspection.name} — required: ${required}; optional: ${optional}`);
    }
  }

  lines.push("", `Current working directory: ${ctx.cwd}`);
  return lines.join("\n");
}

async function startCreateExperimentConversation(pi: ExtensionAPI, ctx: any, initialTargets?: string) {
  const prompt = buildLabCreateKickoff(pi, ctx, initialTargets);

  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
    ctx.ui.notify("Started the lab experiment setup conversation.", "info");
    return;
  }

  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  ctx.ui.notify("Queued the lab experiment setup conversation as a follow-up.", "info");
}

async function showLabsMenu(pi: ExtensionAPI, ctx: any, experimentDirs?: string[]) {
  while (true) {
    const choice = await ctx.ui.select("pi-lab", [
      "Experiments",
      "Runs",
      "Maintenance",
    ]);
    if (!choice) return;

    if (choice === "Experiments") {
      await showExperimentsManager(pi, ctx, experimentDirs);
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

function createLabConductorExtension(pi: ExtensionAPI, experimentDirs?: string[]) {
  const cooldownState = new Map<string, number>();
  const defaultEditToolRenderer = createEditTool(process.cwd());

  pi.on("session_start", (_event, ctx) => {
    const isLaneOrGrader = process.env.PI_LAB_LANE === "1" || process.env.PI_LAB_GRADER === "1";
    const activeExperiments = loadExperiments(ctx.cwd, { experimentDirs })
      .filter((e) => e.experiment.enabled !== false)
      .filter((e) => (e.validation?.errors?.length ?? 0) === 0);
    const builtinToolsToDeactivate = isLaneOrGrader
      ? []
      : Array.from(new Set(activeExperiments.flatMap((e) => deactivateBuiltinToolsOf(e.experiment))));
    const registeredLabToolNames = new Set<string>();
    const seenFixedArgsTools = new Set<string>();
    const allExperiments = activeExperiments.filter((e) => toolNameOf(e.experiment) !== "edit");

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
          `Lab fixed-args interceptor for '${toolName}'. Runs experiment lanes with identical tool args and returns the winning lane result.`,
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
          return renderLabToolResult(result, options, theme);
        },
      });

      registeredLabToolNames.add(toolName);
      ctx.ui.notify(`Registered fixed_args lab interceptor: ${toolName}`, "info");
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
        description: proxyToolDescription(toolName, loaded.experiment.tool?.description),
        promptSnippet: proxyToolPromptSnippet(toolName, loaded.experiment.tool?.description),
        promptGuidelines: proxyToolPromptGuidelines(toolName, loaded.experiment.tool?.description),
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
          return renderLabToolResult(result, options, theme);
        },
      });

      registeredLabToolNames.add(toolName);
      ctx.ui.notify(`Registered proxy lab tool: ${toolName}`, "info");
    }

    const editExperiments = activeExperiments
      .filter((e) => e.experiment.enabled !== false)
      .filter((e) => (e.validation?.errors?.length ?? 0) === 0)
      .filter((e) => toolNameOf(e.experiment) === "edit");

    if (editExperiments.length > 0) {
      const hasProxyEditExperiment = editExperiments.some((e) => {
        const strategy = canonicalExecutionStrategy(executionStrategyOf(e.experiment));
        return strategy === "lane_single_call" || strategy === "lane_multi_call";
      });

      pi.registerTool({
        name: "edit",
        label: "edit",
        description: hasProxyEditExperiment
          ? proxyToolDescription("edit", editExperiments[0]?.experiment.tool?.description)
          : "Edit a file by replacing exact text. pi-lab intercepts this call when configured fixed_args edit experiments match trigger policy.",
        promptSnippet: hasProxyEditExperiment
          ? proxyToolPromptSnippet("edit", editExperiments[0]?.experiment.tool?.description)
          : undefined,
        promptGuidelines: hasProxyEditExperiment
          ? proxyToolPromptGuidelines("edit", editExperiments[0]?.experiment.tool?.description)
          : undefined,
        parameters: hasProxyEditExperiment ? InterceptableEditParams : EditParams,
        renderResult(result, options, theme) {
          return renderLabToolResult(result, options, theme, (innerResult, innerOptions, innerTheme) => {
            if (typeof defaultEditToolRenderer.renderResult === "function") {
              return defaultEditToolRenderer.renderResult(innerResult, innerOptions as any, innerTheme);
            }
            return new Text(String(innerResult?.content?.[0]?.type === "text" ? innerResult.content[0].text : "Done."), 0, 0);
          });
        },

        async execute(toolCallId, params, signal, onUpdate, execCtx) {
          const nativeEdit = createEditTool(execCtx.cwd);

          if (process.env.PI_LAB_LANE === "1" || process.env.PI_LAB_GRADER === "1") {
            if (!isExactEditInput(params)) {
              throw new Error("In PI_LAB_LANE / PI_LAB_GRADER mode, edit requires path/oldText/newText.");
            }
            return nativeEdit.execute(toolCallId, params, signal, onUpdate);
          }

          if (isReplanFlowInput(params)) {
            try {
              return await runSingleCallFlowExperiment(params, "edit", signal, execCtx, cooldownState, experimentDirs);
            } catch (err: any) {
              const msg = err?.message ?? String(err);
              if (!msg.includes("No active lane_single_call experiment matched tool 'edit'")) {
                throw err;
              }
            }

            try {
              return await runMultiCallFlowExperiment(params, "edit", signal, execCtx, cooldownState, experimentDirs);
            } catch (err: any) {
              const msg = err?.message ?? String(err);
              if (!msg.includes("No active lane_multi_call experiment matched tool 'edit'")) {
                throw err;
              }
            }
          }

          if (!isExactEditInput(params)) {
            throw new Error(
              "edit input is invalid. Provide either path/oldText/newText for exact replacement or task/context/constraints for proxy-flow lab experiments.",
            );
          }

          const now = Date.now();
          const loaded = selectExperimentForEdit(execCtx.cwd, params, now, cooldownState, { experimentDirs });
          if (!loaded) {
            return nativeEdit.execute(toolCallId, params, signal, onUpdate);
          }

          const experiment = loaded.experiment;
          cooldownState.set(experiment.id, now);

          const run = createRunContext(execCtx.cwd, loaded.source);
          writeRunManifest(run, experiment, {
            source: loaded.source,
            config_path: loaded.path,
            configured_winner_mode: winnerModeOf(experiment),
            intercepted_tool: "edit",
            intercepted_args: { path: params.path, oldText_len: params.oldText.length, newText_len: params.newText.length },
            execution_strategy: canonicalExecutionStrategy(executionStrategyOf(experiment)),
            lane_harness: process.env.PI_LAB_LANE_HARNESS ?? inferLaneHarness(executionStrategyOf(experiment)),
            stage: "started",
          });

          const policy = defaultPolicy(experiment);
          const laneStatusKey = "lab-lanes";
          const gitRepo = await detectGitRepository(execCtx.cwd, signal);

          if (!gitRepo.ok) {
            const warning = nonGitBaselineFallbackMessage(gitRepo.error);
            execCtx.ui.notify(warning, "warning");

            const fallback = await runBaselineEditFallbackNoGit(
              loaded,
              run,
              execCtx.cwd,
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
              experiment,
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
                lab: {
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
              execCtx.cwd,
              execCtx.sessionManager.getSessionFile(),
              { path: params.path, oldText: params.oldText, newText: params.newText },
              signal,
              (snapshot) => {
                updateLaneWidget(execCtx, laneStatusKey, experiment.id, snapshot);
              },
            );

            writeLaneRecords(run, lanes);
            writeRunManifest(run, experiment, {
              ...summarizeLaneFailures(lanes),
            });

            const winner = await selectWinner(loaded, run, execCtx.cwd, lanes, { intercepted_tool: "edit", intercepted_args: params as Record<string, unknown> }, execCtx.model, signal);
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
            let appliedPatchText: string | undefined;
            let fallbackApplied = false;

            const selectedPatchPath = selected.patch_path && (selected.patch_bytes ?? 0) > 0 ? selected.patch_path : undefined;
            if (selectedPatchPath) {
              const apply = await applyPatchToMain(execCtx.cwd, selectedPatchPath, signal);
              if (!apply.ok) {
                if (policy.on_winner_apply_failure === "fallback_baseline_then_fail") {
                  const baseline = laneById(lanes, getBaselineLaneId(experiment));
                  const baselinePatchPath = baseline?.patch_path && (baseline.patch_bytes ?? 0) > 0 ? baseline.patch_path : undefined;
                  if (baseline && baselinePatchPath && baselinePatchPath !== selectedPatchPath) {
                    const fallbackApply = await applyPatchToMain(execCtx.cwd, baselinePatchPath, signal);
                    if (fallbackApply.ok) {
                      returnedLane = baseline;
                      returnedWinnerMode = `${winner.mode_used} + baseline-apply-fallback`;
                      selectionSource = "baseline_apply_fallback";
                      fallbackReasonCode = "winner_apply_failed_baseline_apply_succeeded";
                      appliedPatchText = readFileSync(baselinePatchPath, "utf8");
                      fallbackApplied = true;
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
              reason: fallbackApplied ? `${winner.reason}; winner apply failed, baseline patch applied` : winner.reason,
              selection_source: selectionSource,
              fallback_reason_code: fallbackReasonCode,
              llm_error_code: winner.llm_error_code,
            });

            const summaryMarkdown = buildExperimentSummaryMarkdown(
              experiment,
              lanes,
              {
                winner_lane_id: returnedLane.lane_id,
                winner_mode: returnedWinnerMode,
                reason: winner.reason,
                scores: winner.scores,
                selection_source: selectionSource,
                fallback_reason_code: fallbackReasonCode,
                llm_error: winner.llm_error,
                llm_error_code: winner.llm_error_code,
              },
              run.dir,
            );

            return {
              content: [{ type: "text", text: combineToolTextWithSummary(returnedLane.output_text ?? `Successfully replaced text in ${params.path}.`, summaryMarkdown) }],
              details: {
                ...(appliedPatchText ? { diff: appliedPatchText, firstChangedLine: undefined } : {}),
                lab: {
                  run_id: run.runId,
                  experiment_id: experiment.id,
                  winner_lane_id: returnedLane.lane_id,
                  winner_mode: returnedWinnerMode,
                  selection_source: selectionSource,
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
            updateLaneWidget(execCtx, laneStatusKey, experiment.id, undefined);
            pruneEmptyRunScaffolding(run);
          }
        },
      });

      registeredLabToolNames.add("edit");
      ctx.ui.notify(`Registered edit lab interceptor (${hasProxyEditExperiment ? "proxy-capable" : "fixed-args-only"}).`, "info");
    }

    if (builtinToolsToDeactivate.length > 0) {
      const activeToolNames = pi.getActiveTools();
      const nextActiveToolNames = Array.from(
        new Set([
          ...activeToolNames.filter((toolName) => !builtinToolsToDeactivate.includes(toolName)),
          ...builtinToolsToDeactivate.filter((toolName) => registeredLabToolNames.has(toolName)),
        ]),
      );
      const changed =
        nextActiveToolNames.length !== activeToolNames.length ||
        nextActiveToolNames.some((toolName, index) => toolName !== activeToolNames[index]);

      if (changed) {
        pi.setActiveTools(nextActiveToolNames);
      }

      ctx.ui.notify(
        `Applied deactivate_builtin_tools from pi-lab config: ${builtinToolsToDeactivate.join(", ")}`,
        "info",
      );
    }
  });

  pi.registerCommand("lab", {
    description: "Manage pi-lab experiments and runs",
    handler: async (args, ctx) => {
      const cmd = (args ?? "").trim();

      if (!cmd) {
        if (ctx.hasUI) {
          await showLabsMenu(pi, ctx, experimentDirs);
          return;
        }
        ctx.ui.notify("Usage: /lab (interactive) or /lab create | experiments | runs | maintenance", "warning");
        return;
      }

      if (cmd === "create" || cmd.startsWith("create ")) {
        await startCreateExperimentConversation(pi, ctx, cmd.slice("create".length).trim() || undefined);
        return;
      }

      if (cmd === "status" || cmd === "validate") {
        const experiments = loadExperiments(ctx.cwd, { experimentDirs });
        if (experiments.length === 0) {
          ctx.ui.notify("No lab experiments found (global or project).", "warning");
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
          ctx.ui.notify("No lab experiments found (global or project).", "warning");
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
        const result = runLabGcCommand(cmd.slice(2).trim(), ctx.cwd);
        ctx.ui.notify(result.message, result.level === "error" ? "error" : result.level === "warning" ? "warning" : "info");
        return;
      }

      ctx.ui.notify("Usage: /lab create | experiments | runs | maintenance", "warning");
    },
  });
}

export function createLabExtension(options: LabExtensionOptions = {}): (pi: ExtensionAPI) => void {
  const experimentDirs = resolveExperimentDirs(options.experimentDirs, options.baseDir);
  return (pi) => createLabConductorExtension(pi, experimentDirs);
}

export default createLabExtension();
