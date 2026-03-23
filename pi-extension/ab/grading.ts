import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedExperiment, LaneRunRecord } from "./types.ts";
import type { RunContext } from "./storage.ts";
import { extractFirstJsonObject, modelToCli, runCommand, safeJsonParse } from "./utils.ts";
import { resolveConfiguredPath } from "./config.ts";
import {
  closeCmuxSurface,
  closeCmuxSurfacesByTitlePrefix,
  createCmuxSurface,
  findCmuxSurfaceByTitle,
  isCmuxAvailable,
  sendCmuxCommand,
  shellEscape,
  waitForCmuxSentinel,
} from "./mux.ts";

export interface GradingResult {
  winner_lane_id: string;
  scores?: Array<{ lane_id: string; score: number; reason?: string }>;
  confidence?: number;
  tie_break_used?: string;
  notes?: string;
}

export type GradingErrorCode =
  | "grader_timeout"
  | "grader_exit_nonzero"
  | "grader_output_not_json"
  | "grader_output_invalid_schema";

function loadGradingPrompt(loaded: LoadedExperiment, cwd: string): string {
  const p = loaded.experiment.grading?.prompt_file ?? loaded.experiment.selection?.grading?.prompt_file;
  if (!p) {
    return "Grade the provided lane outputs and return strict JSON.";
  }

  const resolved = resolveConfiguredPath(p, cwd, loaded.path);
  if (!existsSync(resolved)) {
    return "Grade the provided lane outputs and return strict JSON.";
  }
  return readFileSync(resolved, "utf8");
}

function parseGradingOutput(stdout: string): unknown | null {
  const direct = safeJsonParse<unknown>(stdout.trim());
  if (direct) return direct;

  const extracted = extractFirstJsonObject(stdout) as unknown | null;
  return extracted;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface SessionMessageEntry {
  type: "message";
  timestamp?: string;
  message: {
    role: string;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    content?: Array<{
      type: string;
      name?: string;
      arguments?: Record<string, unknown>;
      text?: string;
      toolCallId?: string;
    }>;
  };
}

function laneToolTranscript(sessionFile: string | undefined): Array<Record<string, unknown>> {
  if (!sessionFile || !existsSync(sessionFile)) return [];

  const lines = readFileSync(sessionFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const transcript: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const parsed = safeJsonParse<SessionMessageEntry>(line);
    if (!parsed || parsed.type !== "message") continue;

    if (parsed.message.role === "assistant") {
      for (const block of parsed.message.content ?? []) {
        if (block.type !== "toolCall") continue;
        transcript.push({
          type: "tool_call",
          tool_name: block.name,
          tool_call_id: block.toolCallId,
          arguments: block.arguments,
          timestamp: parsed.timestamp,
        });
      }
      continue;
    }

    if (parsed.message.role === "toolResult") {
      const text = (parsed.message.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();

      transcript.push({
        type: "tool_result",
        tool_name: parsed.message.toolName,
        tool_call_id: parsed.message.toolCallId,
        is_error: parsed.message.isError === true,
        text: text || undefined,
        timestamp: parsed.timestamp,
      });
    }
  }

  return transcript;
}

function validateGradingResult(
  value: unknown,
  lanes: LaneRunRecord[],
): { ok: true; result: GradingResult } | { ok: false; error: string } {
  if (!isObject(value)) {
    return { ok: false, error: "Grader output is not a JSON object." };
  }

  const laneIds = new Set(lanes.map((l) => l.lane_id));

  const winner = value.winner_lane_id;
  if (typeof winner !== "string" || winner.trim().length === 0) {
    return { ok: false, error: "Missing or invalid winner_lane_id." };
  }
  if (!laneIds.has(winner)) {
    return { ok: false, error: `winner_lane_id '${winner}' is not a known lane.` };
  }

  const result: GradingResult = { winner_lane_id: winner };

  if (value.scores !== undefined) {
    if (!Array.isArray(value.scores)) {
      return { ok: false, error: "scores must be an array when provided." };
    }

    const seen = new Set<string>();
    const normalizedScores: Array<{ lane_id: string; score: number; reason?: string }> = [];

    for (const item of value.scores) {
      if (!isObject(item)) {
        return { ok: false, error: "Each scores[] item must be an object." };
      }

      const laneId = item.lane_id;
      const score = item.score;
      const reason = item.reason;

      if (typeof laneId !== "string" || laneId.trim().length === 0) {
        return { ok: false, error: "scores[].lane_id must be a non-empty string." };
      }
      if (!laneIds.has(laneId)) {
        return { ok: false, error: `scores[].lane_id '${laneId}' is not a known lane.` };
      }
      if (seen.has(laneId)) {
        return { ok: false, error: `Duplicate scores[] entry for lane '${laneId}'.` };
      }
      if (typeof score !== "number" || !Number.isFinite(score)) {
        return { ok: false, error: `scores[].score for lane '${laneId}' must be a finite number.` };
      }
      if (score < 0 || score > 1) {
        return { ok: false, error: `scores[].score for lane '${laneId}' must be within [0,1].` };
      }
      if (reason !== undefined && typeof reason !== "string") {
        return { ok: false, error: `scores[].reason for lane '${laneId}' must be a string when provided.` };
      }

      seen.add(laneId);
      normalizedScores.push({ lane_id: laneId, score, ...(typeof reason === "string" ? { reason } : {}) });
    }

    result.scores = normalizedScores;
  }

  if (value.confidence !== undefined) {
    if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) {
      return { ok: false, error: "confidence must be a finite number when provided." };
    }
    result.confidence = value.confidence;
  }

  if (value.tie_break_used !== undefined) {
    if (typeof value.tie_break_used !== "string") {
      return { ok: false, error: "tie_break_used must be a string when provided." };
    }
    result.tie_break_used = value.tie_break_used;
  }

  if (value.notes !== undefined) {
    if (typeof value.notes !== "string") {
      return { ok: false, error: "notes must be a string when provided." };
    }
    result.notes = value.notes;
  }

  return { ok: true, result };
}

async function runGraderPi(
  argsPi: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal; useCmuxSurface: boolean },
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  if (!(options.useCmuxSurface && isCmuxAvailable())) {
    const res = await runCommand("pi", argsPi, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      env: { ...process.env, PI_AB_GRADER: "1" },
    });
    return { stdout: res.stdout, stderr: res.stderr, code: res.code, timedOut: res.timedOut };
  }

  const surface = createCmuxSurface("AB Grader", "right");
  const keepDebugPanes = process.env.PI_AB_KEEP_PANES === "1";

  try {
    const sentinel = "__PI_AB_GRADER_DONE_";
    const piCmd = ["PI_AB_GRADER=1", "pi", ...argsPi.map((a) => shellEscape(a))].join(" ");
    const cmd = `cd ${shellEscape(options.cwd)} && ${piCmd}; echo '${sentinel}'$?'__'`;

    sendCmuxCommand(surface, cmd);
    const waited = await waitForCmuxSentinel(surface, sentinel, options.timeoutMs, options.signal);

    return {
      stdout: waited.screen,
      stderr: waited.exitCode === 124 ? "Grader timed out in cmux mode" : "",
      code: waited.exitCode,
      timedOut: waited.exitCode === 124,
    };
  } finally {
    if (!keepDebugPanes) {
      try {
        closeCmuxSurface(surface);
      } catch {
        try {
          const reboundSurface = findCmuxSurfaceByTitle("AB Grader");
          if (reboundSurface) closeCmuxSurface(reboundSurface);
        } catch {}
      }

      // Final sweep: close any orphaned grader pane.
      try {
        closeCmuxSurfacesByTitlePrefix("AB Grader");
      } catch {}
    }
  }
}

export async function runGradingProcess(
  loaded: LoadedExperiment,
  run: RunContext,
  cwd: string,
  lanes: LaneRunRecord[],
  args: { intercepted_tool: string; intercepted_args: Record<string, unknown> },
  currentModel: { provider?: string; id?: string } | undefined,
  signal?: AbortSignal,
): Promise<{ result: GradingResult | null; error?: string; error_code?: GradingErrorCode }> {
  const promptText = loadGradingPrompt(loaded, cwd);
  const includeToolCalls =
    loaded.experiment.grading?.include?.tool_calls ??
    loaded.experiment.selection?.grading?.include?.tool_calls ??
    false;

  const gradingInput: Record<string, unknown> = {
    experiment_id: loaded.experiment.id,
    mode: loaded.experiment.mode,
    intercepted_tool: args.intercepted_tool,
    intercepted_args: args.intercepted_args,
    lanes,
  };

  if (includeToolCalls) {
    gradingInput.lane_tool_calls = lanes.map((lane) => ({
      lane_id: lane.lane_id,
      transcript: laneToolTranscript(lane.session_file),
    }));
  }

  const gradingInputPath = join(run.dir, "artifacts", "grading-input.json");
  const gradingPromptPath = join(run.dir, "artifacts", "grading-prompt.md");
  const gradingOutputPath = join(run.dir, "artifacts", "grading-output.json");

  writeFileSync(gradingInputPath, JSON.stringify(gradingInput, null, 2), "utf8");
  writeFileSync(
    gradingPromptPath,
    `${promptText}\n\nReturn STRICT JSON only with fields: winner_lane_id, scores[], confidence, tie_break_used, notes.`,
    "utf8",
  );

  const timeoutMs = loaded.experiment.grading?.timeout_ms ?? loaded.experiment.selection?.grading?.timeout_ms ?? 12000;
  const modelOverride = loaded.experiment.grading?.model ?? loaded.experiment.selection?.grading?.model;
  const model = modelOverride ?? modelToCli(currentModel);

  const argsPiBase: string[] = ["-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"];
  if (model) {
    argsPiBase.push("--model", model);
  }

  const debugUiMode = (process.env.PI_AB_DEBUG_UI ?? loaded.experiment.debug_ui ?? "none").toLowerCase();

  let attempt = 1;
  let lastSchemaError: string | undefined;

  while (attempt <= 2) {
    const promptPathForAttempt =
      attempt === 1
        ? gradingPromptPath
        : join(run.dir, "artifacts", `grading-prompt-retry-${attempt}.md`);

    if (attempt > 1) {
      const retryPrompt = [
        promptText,
        "",
        "Your previous response was invalid JSON/schema.",
        `Invalid reason: ${lastSchemaError ?? "unknown"}`,
        "Return ONLY strict JSON matching:",
        '{"winner_lane_id":"<lane>","scores":[{"lane_id":"A","score":0.0,"reason":"..."}],"confidence":0.0,"tie_break_used":"...","notes":"..."}',
        "Score must be in [0.0, 1.0].",
      ].join("\n");
      writeFileSync(promptPathForAttempt, retryPrompt, "utf8");
    }

    const argsPi = [...argsPiBase, `@${promptPathForAttempt}`, `@${gradingInputPath}`];
    const res = await runGraderPi(argsPi, {
      cwd,
      timeoutMs,
      signal,
      useCmuxSurface: loaded.experiment.debug === true && debugUiMode !== "none",
    });

    const rawOutPath = join(run.dir, "artifacts", `grading-raw-output-${attempt}.txt`);
    writeFileSync(rawOutPath, `${res.stdout}\n\n--- STDERR ---\n${res.stderr}`, "utf8");

    if (res.timedOut) {
      return {
        result: null,
        error: `Grader timed out after ${timeoutMs}ms`,
        error_code: "grader_timeout",
      };
    }

    if (res.code !== 0) {
      return {
        result: null,
        error: `Grader process failed (code=${res.code}). stderr: ${res.stderr || "<empty>"}`,
        error_code: "grader_exit_nonzero",
      };
    }

    const parsed = parseGradingOutput(res.stdout);
    if (!parsed) {
      lastSchemaError = "Grader output did not contain a JSON object.";
      if (attempt === 1) {
        attempt += 1;
        continue;
      }
      return {
        result: null,
        error: lastSchemaError,
        error_code: "grader_output_not_json",
      };
    }

    const validated = validateGradingResult(parsed, lanes);
    if (!validated.ok) {
      lastSchemaError = `Invalid grader output schema: ${validated.error}`;
      if (attempt === 1) {
        attempt += 1;
        continue;
      }
      return {
        result: null,
        error: lastSchemaError,
        error_code: "grader_output_invalid_schema",
      };
    }

    writeFileSync(gradingOutputPath, JSON.stringify(validated.result, null, 2), "utf8");
    return { result: validated.result };
  }

  return {
    result: null,
    error: "Unknown grading failure",
    error_code: "grader_output_invalid_schema",
  };
}
