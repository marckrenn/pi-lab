import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

function experimentsDir(cwd: string, scope: "project" | "global"): string {
  return scope === "project"
    ? join(cwd, ".pi", "ab", "experiments")
    : join(homedir(), ".pi", "agent", "ab", "experiments");
}

function promptsDir(cwd: string, scope: "project" | "global"): string {
  return scope === "project"
    ? join(cwd, ".pi", "ab", "prompts")
    : join(homedir(), ".pi", "agent", "ab", "prompts");
}

function asId(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "ab-experiment";
}

export async function runAbWizard(
  ctx: ExtensionContext | ExtensionCommandContext,
): Promise<{ configPath?: string; cancelled: boolean }> {
  const scopeChoice = await ctx.ui.select("A/B experiment scope", ["project", "global"]);
  if (!scopeChoice) return { cancelled: true };
  const scope = scopeChoice as "project" | "global";

  const name = (await ctx.ui.input("Experiment id", "edit-lanes-v1"))?.trim();
  if (!name) return { cancelled: true };
  const id = asId(name);

  const targetTool = (await ctx.ui.input("Target tool name", "edit"))?.trim() || "edit";

  const executionStrategyChoice = await ctx.ui.select("Execution strategy", ["fixed_args", "lane_single_call", "lane_multi_call"]);
  if (!executionStrategyChoice) return { cancelled: true };

  const sampleRateRaw = await ctx.ui.input("Sample rate (0..1)", "1.0");
  if (sampleRateRaw == null) return { cancelled: true };
  const sampleRate = Number(sampleRateRaw);

  const regexDefault = executionStrategyChoice === "fixed_args" && targetTool === "edit" ? "^fixtures/ab-test/" : "";
  const regex = (await ctx.ui.input("Optional path regex trigger", regexDefault))?.trim() ?? "";

  const timeoutRaw = await ctx.ui.input("Lane timeout ms", "15000");
  if (timeoutRaw == null) return { cancelled: true };
  const timeoutMs = Math.max(1, Number(timeoutRaw));

  const winnerModeChoice = await ctx.ui.select("How should the winner be chosen?", ["hardcoded", "formula", "llm", "blend"]);
  if (!winnerModeChoice) return { cancelled: true };

  let llmPromptMode: "file" | "inline" = "file";
  let llmPromptInline = "";
  let includeToolCalls = false;
  let blendMode: "llm_tiebreaker" | "llm_score" = "llm_tiebreaker";
  let formulaWeight = 1;
  let llmWeight = 1;

  const laneA = (await ctx.ui.input("Lane A extension path", "./fixtures/ab-test/lanes/edit-perm-a.ts"))?.trim();
  if (!laneA) return { cancelled: true };
  const laneB = (await ctx.ui.input("Lane B extension path", "./fixtures/ab-test/lanes/edit-perm-b.ts"))?.trim();
  if (!laneB) return { cancelled: true };
  const laneC = (await ctx.ui.input("Lane C extension path", "./fixtures/ab-test/lanes/edit-perm-c.ts"))?.trim();
  if (!laneC) return { cancelled: true };

  const baselineLaneChoice = await ctx.ui.select("Baseline lane (fallback lane)", ["A", "B", "C"]);
  if (!baselineLaneChoice) return { cancelled: true };

  let hardcodedWinnerLane: "A" | "B" | "C" | undefined;
  if (winnerModeChoice === "hardcoded") {
    const choice = await ctx.ui.select("Which lane should always win?", ["A", "B", "C"]);
    if (!choice) return { cancelled: true };
    hardcodedWinnerLane = choice as "A" | "B" | "C";
  }

  if (winnerModeChoice === "llm" || winnerModeChoice === "blend") {
    const promptMode = await ctx.ui.select("LLM prompt source", ["file", "inline"]);
    if (!promptMode) return { cancelled: true };
    llmPromptMode = promptMode as "file" | "inline";

    if (llmPromptMode === "inline") {
      llmPromptInline = (await ctx.ui.input("Inline LLM prompt", "Prefer correctness first, then safety, then efficiency."))?.trim() ?? "";
    }

    const includeToolCallsChoice = await ctx.ui.select("Include lane tool-call transcripts for LLM judging?", ["no", "yes"]);
    if (!includeToolCallsChoice) return { cancelled: true };
    includeToolCalls = includeToolCallsChoice === "yes";
  }

  if (winnerModeChoice === "blend") {
    const hm = await ctx.ui.select("Blend mode", ["llm_tiebreaker", "llm_score"]);
    if (!hm) return { cancelled: true };
    blendMode = hm as "llm_tiebreaker" | "llm_score";

    if (blendMode === "llm_score") {
      const formulaRaw = await ctx.ui.input("Formula weight", "1.0");
      if (formulaRaw == null) return { cancelled: true };
      const llmRaw = await ctx.ui.input("LLM weight", "1.0");
      if (llmRaw == null) return { cancelled: true };
      formulaWeight = Number.isFinite(Number(formulaRaw)) ? Number(formulaRaw) : 1;
      llmWeight = Number.isFinite(Number(llmRaw)) ? Number(llmRaw) : 1;
    }
  }

  const expDir = experimentsDir(ctx.cwd, scope);
  const promptDir = promptsDir(ctx.cwd, scope);
  mkdirSync(expDir, { recursive: true });
  mkdirSync(promptDir, { recursive: true });

  const configPath = join(expDir, `${id}.json`);
  const promptPath = join(promptDir, "grade-default.md");

  const config = {
    id,
    enabled: true,
    tool: {
      name: targetTool,
    },
    ...(Number.isFinite(sampleRate) || regex
      ? {
          trigger: {
            ...(Number.isFinite(sampleRate) ? { sample_rate: Number(sampleRate.toFixed(2)) } : {}),
            ...(regex ? { when_path_regex: regex } : {}),
          },
        }
      : {}),
    execution: {
      strategy: executionStrategyChoice,
      timeout_ms: timeoutMs,
    },
    winner: {
      mode: winnerModeChoice,
      ...(winnerModeChoice === "hardcoded" ? { hardcoded_lane: hardcodedWinnerLane } : {}),
      ...(winnerModeChoice === "formula" || winnerModeChoice === "blend"
        ? {
            formula: {
              objective: "min(latency_ms)",
              tie_breakers: ["max(success)", "min(total_tokens)"],
            },
          }
        : {}),
      ...(winnerModeChoice === "llm" || winnerModeChoice === "blend"
        ? {
            llm: {
              execution: "process",
              timeout_ms: 12000,
              ...(llmPromptMode === "file"
                ? { prompt_file: promptPath }
                : llmPromptInline
                  ? { prompt: llmPromptInline }
                  : {}),
              ...(includeToolCalls ? { include_tool_calls: true } : {}),
            },
          }
        : {}),
      ...(winnerModeChoice === "blend"
        ? {
            blend: {
              mode: blendMode,
              ...(blendMode === "llm_score"
                ? {
                    formula_weight: Number(formulaWeight.toFixed(3)),
                    llm_weight: Number(llmWeight.toFixed(3)),
                  }
                : {}),
            },
          }
        : {}),
    },
    lanes: [
      { label: "A", baseline: baselineLaneChoice === "A", extensions: [laneA] },
      { label: "B", baseline: baselineLaneChoice === "B", extensions: [laneB] },
      { label: "C", baseline: baselineLaneChoice === "C", extensions: [laneC] },
    ],
    failure_policy: {
      on_lane_timeout: "exclude_continue",
      on_lane_crash: "exclude_continue",
      on_llm_failure: "fallback_formula_then_baseline",
      on_winner_apply_failure: "fallback_baseline_then_fail",
      all_lanes_failed: "fallback_baseline",
    },
    debug: {
      enabled: false,
      ui: "none",
    },
  };

  if (regex && executionStrategyChoice !== "fixed_args") {
    ctx.ui.notify(
      "trigger.when_path_regex only applies when tool args include a path. For lane_single_call/lane_multi_call this is usually ignored unless your tool schema has path.",
      "warning",
    );
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  if ((winnerModeChoice === "llm" || winnerModeChoice === "blend") && llmPromptMode === "file" && !existsSync(promptPath)) {
    const prompt = `You are grading lane outputs for a coding-tool A/B experiment.\nReturn strict JSON only:\n{"winner_lane_id":"<id>","scores":[{"lane_id":"A","score":0.0,"reason":"..."}],"confidence":0.0,"tie_break_used":"...","notes":"..."}\nRules: scores must be within [0.0, 1.0]. Evaluate correctness first, then minimal safe changes, then efficiency metrics.`;
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
  }

  if (targetTool !== "edit" && executionStrategyChoice === "fixed_args") {
    ctx.ui.notify(
      `Experiment saved for tool.name='${targetTool}' (fixed_args). Ensure each lane exposes '${targetTool}' with compatible schema; capability policy is logged as intersection/best_effort in run.json.`,
      "info",
    );
  }

  ctx.ui.notify(`A/B experiment written: ${configPath}`, "info");
  return { configPath: resolve(configPath), cancelled: false };
}
