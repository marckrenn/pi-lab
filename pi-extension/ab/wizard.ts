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

  const modeChoice = await ctx.ui.select("Selection mode", ["deterministic", "shadow", "grading", "hybrid"]);
  if (!modeChoice) return { cancelled: true };

  let hybridModeChoice: "llm_tiebreaker" | "llm_score" = "llm_tiebreaker";
  let hybridDetWeight = 1;
  let hybridLlmWeight = 1;
  if (modeChoice === "hybrid") {
    const hm = await ctx.ui.select("Hybrid mode", ["llm_tiebreaker", "llm_score"]);
    if (!hm) return { cancelled: true };
    hybridModeChoice = hm as "llm_tiebreaker" | "llm_score";

    if (hybridModeChoice === "llm_score") {
      const detRaw = await ctx.ui.input("Hybrid deterministic weight", "1.0");
      if (detRaw == null) return { cancelled: true };
      const llmRaw = await ctx.ui.input("Hybrid LLM weight", "1.0");
      if (llmRaw == null) return { cancelled: true };
      hybridDetWeight = Number.isFinite(Number(detRaw)) ? Number(detRaw) : 1;
      hybridLlmWeight = Number.isFinite(Number(llmRaw)) ? Number(llmRaw) : 1;
    }
  }

  const executionStrategyChoice = await ctx.ui.select("Execution strategy", ["fixed_args", "lane_single_call", "lane_multi_call"]);
  if (!executionStrategyChoice) return { cancelled: true };

  const targetTool = (await ctx.ui.input("Target tool name", "edit"))?.trim() || "edit";

  const sampleRateRaw = await ctx.ui.input("Sample rate (0..1)", "1.0");
  if (sampleRateRaw == null) return { cancelled: true };
  const sampleRate = Number(sampleRateRaw);

  const timeoutRaw = await ctx.ui.input("Lane timeout ms", "15000");
  if (timeoutRaw == null) return { cancelled: true };
  const timeoutMs = Math.max(1, Number(timeoutRaw));

  const includeToolCallsChoice = await ctx.ui.select("Include lane tool-call transcripts in grading input?", ["no", "yes"]);
  if (!includeToolCallsChoice) return { cancelled: true };
  const includeToolCallsInGrading = includeToolCallsChoice === "yes";

  const regexDefault = executionStrategyChoice === "fixed_args" && targetTool === "edit" ? "^fixtures/ab-test/" : "";
  const regex = (await ctx.ui.input("Optional path regex trigger", regexDefault))?.trim() ?? "";
  const laneA = (await ctx.ui.input("Lane A extension path", "./fixtures/ab-test/lanes/edit-perm-a.ts"))?.trim();
  if (!laneA) return { cancelled: true };
  const laneB = (await ctx.ui.input("Lane B extension path (primary)", "./fixtures/ab-test/lanes/edit-perm-b.ts"))?.trim();
  if (!laneB) return { cancelled: true };
  const laneC = (await ctx.ui.input("Lane C extension path", "./fixtures/ab-test/lanes/edit-perm-c.ts"))?.trim();
  if (!laneC) return { cancelled: true };

  const expDir = experimentsDir(ctx.cwd, scope);
  const promptDir = promptsDir(ctx.cwd, scope);
  mkdirSync(expDir, { recursive: true });
  mkdirSync(promptDir, { recursive: true });

  const configPath = join(expDir, `${id}.json`);
  const promptPath = join(promptDir, "grade-default.md");

  const config = {
    id,
    enabled: true,
    target_tool: targetTool,
    trigger: {
      tool: targetTool,
      sample_rate: Number.isFinite(sampleRate) ? Number(sampleRate.toFixed(2)) : 1,
      ...(regex ? { when_path_regex: regex } : {}),
    },
    mode: modeChoice,
    execution_strategy: executionStrategyChoice,
    lanes: [
      { id: "A", primary: false, extensions: [laneA] },
      { id: "B", primary: true, extensions: [laneB] },
      { id: "C", primary: false, extensions: [laneC] },
    ],
    timeout_ms: timeoutMs,
    debug: false,
    lane_harness: executionStrategyChoice === "fixed_args" ? "direct" : "pi_prompt",
    selection: {
      deterministic: {
        objective: "min(latency_ms)",
        tie_breakers: ["max(success)", "min(total_tokens)"],
      },
      ...(modeChoice === "hybrid"
        ? {
            hybrid: {
              mode: hybridModeChoice,
              ...(hybridModeChoice === "llm_score"
                ? {
                    deterministic_weight: Number(hybridDetWeight.toFixed(3)),
                    llm_weight: Number(hybridLlmWeight.toFixed(3)),
                  }
                : {}),
            },
          }
        : {}),
    },
    grading: {
      execution: "process",
      timeout_ms: 12000,
      prompt_file: promptPath,
      include: {
        tool_calls: includeToolCallsInGrading,
      },
    },
    failure_policy: {
      on_lane_timeout: "exclude_continue",
      on_lane_crash: "exclude_continue",
      on_grading_failure: "fallback_deterministic_then_shadow",
      on_winner_apply_failure: "fallback_primary_then_fail",
      all_lanes_failed: "fallback_primary",
    },
  };

  if (regex && executionStrategyChoice !== "fixed_args") {
    ctx.ui.notify(
      "when_path_regex only applies when tool args include a path. For lane_single_call/lane_multi_call this is typically ignored unless your tool schema has path.",
      "warning",
    );
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  if (!existsSync(promptPath)) {
    const prompt = `You are grading lane outputs for a coding-tool A/B experiment.\nReturn strict JSON only:\n{\"winner_lane_id\":\"<id>\",\"scores\":[{\"lane_id\":\"A\",\"score\":0.0,\"reason\":\"...\"}],\"confidence\":0.0,\"tie_break_used\":\"...\",\"notes\":\"...\"}\nRules: scores must be within [0.0, 1.0]. Evaluate correctness first, then minimal safe changes, then efficiency metrics.`;
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
  }

  if (targetTool !== "edit" && executionStrategyChoice === "fixed_args") {
    ctx.ui.notify(
      `Experiment saved for target_tool='${targetTool}' (fixed_args). Ensure each lane exposes '${targetTool}' with compatible schema; capability policy is logged as intersection/best_effort in run.json.`,
      "info",
    );
  }

  ctx.ui.notify(`A/B experiment written: ${configPath}`, "info");
  return { configPath: resolve(configPath), cancelled: false };
}
