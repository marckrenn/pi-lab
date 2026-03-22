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

  const modeChoice = await ctx.ui.select("Selection mode", ["deterministic", "shadow", "grading"]);
  if (!modeChoice) return { cancelled: true };

  const sampleRateRaw = await ctx.ui.input("Sample rate (0..1)", "1.0");
  if (sampleRateRaw == null) return { cancelled: true };
  const sampleRate = Number(sampleRateRaw);

  const timeoutRaw = await ctx.ui.input("Lane timeout ms", "15000");
  if (timeoutRaw == null) return { cancelled: true };
  const timeoutMs = Math.max(1, Number(timeoutRaw));

  const regex = (await ctx.ui.input("Optional path regex trigger", "^fixtures/ab-test/"))?.trim() ?? "";
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
    target_tool: "edit",
    trigger: {
      tool: "edit",
      sample_rate: Number.isFinite(sampleRate) ? Number(sampleRate.toFixed(2)) : 1,
      ...(regex ? { when_path_regex: regex } : {}),
    },
    mode: modeChoice,
    lanes: [
      { id: "A", primary: false, extensions: [laneA] },
      { id: "B", primary: true, extensions: [laneB] },
      { id: "C", primary: false, extensions: [laneC] },
    ],
    timeout_ms: timeoutMs,
    debug: false,
    selection: {
      deterministic: {
        objective: "min(latency_ms)",
        tie_breakers: ["max(success)", "min(total_tokens)"],
      },
    },
    grading: {
      execution: "process",
      timeout_ms: 12000,
      prompt_file: promptPath,
    },
    failure_policy: {
      on_lane_timeout: "exclude_continue",
      on_lane_crash: "exclude_continue",
      on_grading_failure: "fallback_deterministic_then_shadow",
      on_winner_apply_failure: "fallback_primary_then_fail",
      all_lanes_failed: "fallback_primary",
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  if (!existsSync(promptPath)) {
    const prompt = `You are grading lane outputs for a coding-tool A/B experiment.\nReturn strict JSON only:\n{\"winner_lane_id\":\"<id>\",\"scores\":[{\"lane_id\":\"A\",\"score\":0.0,\"reason\":\"...\"}],\"confidence\":0.0,\"tie_break_used\":\"...\",\"notes\":\"...\"}\nEvaluate correctness first, then minimal safe changes, then efficiency metrics.`;
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
  }

  ctx.ui.notify(`A/B experiment written: ${configPath}`, "info");
  return { configPath: resolve(configPath), cancelled: false };
}
