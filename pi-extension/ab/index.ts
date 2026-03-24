import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getBaselineLaneId } from "./selection.ts";
import {
  canonicalExecutionStrategy,
  executionStrategyOf,
  formatExperimentSummary,
  loadExperiments,
  selectExperimentForEdit,
  selectExperimentForTool,
  toolNameOf,
  winnerModeOf,
} from "./config.ts";
import { createRunContext, writeLaneRecords, writeRunManifest } from "./storage.ts";
import { runAbWizard } from "./wizard.ts";
import {
  applyPatchToMain,
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
    if (rawPath.includes("/pi-extension/ab/index.")) continue;
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

function formatLaneStatus(experimentId: string, snapshot: LaneProgressSnapshot): string {
  const lanes = snapshot.lanes
    .map((lane) => {
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
      const secs = lane.elapsed_ms != null ? ` ${Math.max(0, lane.elapsed_ms / 1000).toFixed(1)}s` : "";
      return `${lane.lane_id}${icon}${secs}`;
    })
    .join("  ");

  return `AB ${experimentId}: ${lanes}`;
}

type NativeToolDelegate = {
  description?: string;
  parameters?: any;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: any,
  ) => Promise<any>;
};

function createNativeToolDelegate(toolName: string, cwd: string): NativeToolDelegate | undefined {
  if (toolName === "read") return createReadTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "bash") return createBashTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "edit") return createEditTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "write") return createWriteTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "grep") return createGrepTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "find") return createFindTool(cwd) as unknown as NativeToolDelegate;
  if (toolName === "ls") return createLsTool(cwd) as unknown as NativeToolDelegate;
  return undefined;
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
  nativeTool?: NativeToolDelegate,
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
      return nativeTool.execute(toolCallId, params, signal, onUpdate);
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

  const run = createRunContext(ctx.cwd);
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

  try {
    const laneRun = await runExperimentLanesFixedArgsTool(
      loaded,
      run,
      ctx.cwd,
      toolName,
      params,
      signal,
      (snapshot) => {
        ctx.ui.setStatus(laneStatusKey, formatLaneStatus(experiment.id, snapshot));
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

    writeRunManifest(run, experiment, {
      stage: "completed",
      winner_lane_id: selected.lane_id,
      winner_mode: winner.mode_used,
      reason: winner.reason,
      selection_source: winner.selection_source,
      fallback_reason_code: winner.fallback_reason_code,
      llm_error_code: winner.llm_error_code,
    });

    return {
      content: [{ type: "text", text: selected.output_text ?? "Done." }],
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
    ctx.ui.setStatus(laneStatusKey, undefined);
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

  const run = createRunContext(ctx.cwd);
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

  try {
    const laneRun = await runExperimentLanesSingleCall(
      loaded,
      run,
      ctx.cwd,
      toolName,
      params,
      signal,
      (snapshot) => {
        ctx.ui.setStatus(laneStatusKey, formatLaneStatus(experiment.id, snapshot));
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

    writeRunManifest(run, experiment, {
      stage: "completed",
      winner_lane_id: selected.lane_id,
      winner_mode: winner.mode_used,
      reason: winner.reason,
      selection_source: winner.selection_source,
      fallback_reason_code: winner.fallback_reason_code,
      llm_error_code: winner.llm_error_code,
    });

    return {
      content: [{ type: "text", text: selected.output_text ?? "Flow completed." }],
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
    ctx.ui.setStatus(laneStatusKey, undefined);
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

  const run = createRunContext(ctx.cwd);
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

  try {
    const lanes = await runExperimentLanesMultiCall(
      loaded,
      run,
      ctx.cwd,
      toolName,
      params,
      signal,
      (snapshot) => {
        ctx.ui.setStatus(laneStatusKey, formatLaneStatus(experiment.id, snapshot));
      },
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

    writeRunManifest(run, experiment, {
      stage: "completed",
      winner_lane_id: selected.lane_id,
      winner_mode: winner.mode_used,
      reason: winner.reason,
      selection_source: winner.selection_source,
      fallback_reason_code: winner.fallback_reason_code,
      llm_error_code: winner.llm_error_code,
    });

    return {
      content: [{ type: "text", text: selected.output_text ?? "Flow completed." }],
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
    ctx.ui.setStatus(laneStatusKey, undefined);
  }
}

function createAbConductorExtension(pi: ExtensionAPI, experimentDirs?: string[]) {
  const cooldownState = new Map<string, number>();

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

      pi.registerTool({
        name: toolName,
        label: existing?.name ?? toolName,
        description:
          existing?.description ??
          `AB fixed-args interceptor for '${toolName}'. Runs experiment lanes with identical tool args and returns the winning lane result.`,
        parameters: existing?.parameters ?? Type.Object({}, { additionalProperties: true }),
        async execute(toolCallId, params, signal, onUpdate, execCtx) {
          const nativeTool = createNativeToolDelegate(toolName, execCtx.cwd);
          return runFixedArgsToolExperiment(
            params as Record<string, unknown>,
            toolName,
            toolCallId,
            signal,
            onUpdate,
            execCtx,
            cooldownState,
            experimentDirs,
            nativeTool,
          );
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
      });

      ctx.ui.notify(`Registered proxy A/B tool: ${toolName}`, "info");
    }
  });

  pi.registerCommand("lab", {
    description: "pi-lab controls: /lab wizard | status | validate | gc",
    handler: async (args, ctx) => {
      const cmd = (args ?? "").trim();

      if (!cmd || cmd === "wizard") {
        await runAbWizard(ctx);
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

      if (cmd === "gc" || cmd.startsWith("gc ")) {
        const result = runAbGcCommand(cmd.slice(2).trim(), ctx.cwd);
        ctx.ui.notify(result.message, result.level === "error" ? "error" : result.level === "warning" ? "warning" : "info");
        return;
      }

      ctx.ui.notify("Usage: /lab wizard | status | validate | gc", "warning");
    },
  });

  pi.registerTool({
    name: "lab_setup_wizard",
    label: "pi-lab Setup Wizard",
    description: "Interactive wizard to create an experiment JSON config (global or project scope).",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const result = await runAbWizard(ctx);
      if (result.cancelled) {
        return { content: [{ type: "text", text: "Setup wizard cancelled." }], details: { cancelled: true } };
      }
      return {
        content: [{ type: "text", text: `Experiment created at ${result.configPath}` }],
        details: { cancelled: false, path: result.configPath },
      };
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Edit a file by replacing exact text. A/B conductor intercepts this call when configured experiments match trigger policy.",
    parameters: EditParams,

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

      const run = createRunContext(ctx.cwd);
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

      try {
        const lanes = await runExperimentLanes(
          loaded,
          run,
          ctx.cwd,
          ctx.sessionManager.getSessionFile(),
          { path: params.path, oldText: params.oldText, newText: params.newText },
          signal,
          (snapshot) => {
            ctx.ui.setStatus(laneStatusKey, formatLaneStatus(experiment.id, snapshot));
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

                return {
                  content: [{ type: "text", text: baseline.output_text ?? `Successfully replaced text in ${params.path}.` }],
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

        return {
          content: [{ type: "text", text: selected.output_text ?? `Successfully replaced text in ${params.path}.` }],
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
        ctx.ui.setStatus(laneStatusKey, undefined);
      }
    },
  });
}

export function createAbExtension(options: AbExtensionOptions = {}): (pi: ExtensionAPI) => void {
  const experimentDirs = resolveExperimentDirs(options.experimentDirs, options.baseDir);
  return (pi) => createAbConductorExtension(pi, experimentDirs);
}

export default createAbExtension();
