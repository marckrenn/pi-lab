import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { chooseDeterministicLane, getPrimaryLaneId } from "./selection.ts";
import { formatExperimentSummary, loadExperiments, selectExperimentForEdit } from "./config.ts";
import { createRunContext, writeLaneRecords, writeRunManifest } from "./storage.ts";
import { runAbWizard } from "./wizard.ts";
import { applyPatchToMain, runExperimentLanes } from "./runner.ts";
import { runGradingProcess } from "./grading.ts";
import type { LaneRunRecord, LoadedExperiment, WinnerSelection } from "./types.ts";

const EditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
  newText: Type.String({ description: "New text to replace the old text with" }),
});

function defaultPolicy(experiment: LoadedExperiment["experiment"]) {
  const fp = experiment.failure_policy ?? {};
  return {
    on_grading_failure: fp.on_grading_failure ?? "fallback_deterministic_then_shadow",
    on_winner_apply_failure: fp.on_winner_apply_failure ?? "fallback_primary_then_fail",
    all_lanes_failed: fp.all_lanes_failed ?? "fail_tool_call",
  };
}

function successfulLanes(records: LaneRunRecord[]): LaneRunRecord[] {
  return records.filter((r) => r.status === "success" && !!r.patch_path && (r.patch_bytes ?? 0) > 0);
}

async function selectWinner(
  loaded: LoadedExperiment,
  run: { runId: string; dir: string },
  cwd: string,
  records: LaneRunRecord[],
  editArgs: { path: string; oldText: string; newText: string },
  model: { provider?: string; id?: string } | undefined,
  signal?: AbortSignal,
): Promise<WinnerSelection> {
  const experiment = loaded.experiment;
  const policy = defaultPolicy(experiment);
  const primaryLaneId = getPrimaryLaneId(experiment);
  const success = successfulLanes(records);

  if (success.length === 0) {
    if (policy.all_lanes_failed === "fallback_primary") {
      return {
        winner_lane_id: primaryLaneId,
        mode_used: "shadow",
        reason: "all lanes failed; fallback_primary policy",
        selection_source: "fallback_shadow_primary",
        fallback_reason_code: "all_lanes_failed",
      };
    }
    throw new Error("All experiment lanes failed.");
  }

  if (experiment.mode === "shadow") {
    const hasPrimary = success.some((r) => r.lane_id === primaryLaneId);
    return {
      winner_lane_id: hasPrimary ? primaryLaneId : success[0].lane_id,
      mode_used: "shadow",
      reason: hasPrimary ? "shadow primary lane" : "shadow primary failed, first successful lane fallback",
      selection_source: hasPrimary ? "shadow_primary" : "shadow_first_success_fallback",
      fallback_reason_code: hasPrimary ? undefined : "shadow_primary_not_successful",
    };
  }

  if (experiment.mode === "deterministic") {
    const picked = chooseDeterministicLane(experiment, records);
    if (!picked.laneId) throw new Error("Deterministic selection found no winner.");
    return {
      winner_lane_id: picked.laneId,
      mode_used: "deterministic",
      reason: picked.reason,
      selection_source: "deterministic",
    };
  }

  // grading mode
  const grade = await runGradingProcess(loaded, run, cwd, records, editArgs, model, signal);
  const gradeWinner = grade.result?.winner_lane_id;
  const gradeWinnerUsable = gradeWinner ? success.some((r) => r.lane_id === gradeWinner) : false;

  if (grade.result && gradeWinner && gradeWinnerUsable) {
    return {
      winner_lane_id: gradeWinner,
      mode_used: "grading",
      reason: "grading process winner",
      selection_source: "grading",
    };
  }

  const gradingFailureCode = grade.error_code ?? (gradeWinner ? "grading_winner_not_successful" : "grading_no_result");

  if (policy.on_grading_failure === "fallback_deterministic_then_shadow") {
    const picked = chooseDeterministicLane(experiment, records);
    if (picked.laneId) {
      return {
        winner_lane_id: picked.laneId,
        mode_used: "grading-fallback-deterministic",
        reason: `grading fallback: ${picked.reason}`,
        selection_source: "grading_fallback_deterministic",
        fallback_reason_code: gradingFailureCode,
        grading_error: grade.error,
        grading_error_code: grade.error_code,
      };
    }
  }

  return {
    winner_lane_id: primaryLaneId,
    mode_used: "grading-fallback-shadow",
    reason: "grading failed; fallback shadow primary",
    selection_source: "grading_fallback_shadow",
    fallback_reason_code: gradingFailureCode,
    grading_error: grade.error,
    grading_error_code: grade.error_code,
  };
}

function laneById(records: LaneRunRecord[], id: string): LaneRunRecord | undefined {
  return records.find((r) => r.lane_id === id);
}

interface AbGcOptions {
  keepLast: number;
  olderThanMs?: number;
  force: boolean;
  project?: string;
  allProjects: boolean;
}

function parseDurationToMs(value: string): number | null {
  const m = value.trim().match(/^(\d+)([smhd])$/i);
  if (!m) return null;
  const amount = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const factor = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return amount * factor;
}

function parseGcOptions(args: string): { options?: AbGcOptions; error?: string; help?: boolean } {
  const tokens = args.split(/\s+/).filter(Boolean);
  const options: AbGcOptions = { keepLast: 10, force: false, allProjects: false };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--help" || token === "-h") return { help: true };
    if (token === "--force") {
      options.force = true;
      continue;
    }
    if (token === "--all-projects") {
      options.allProjects = true;
      continue;
    }
    if (token === "--project") {
      const value = tokens[++i];
      if (!value) return { error: "Missing value for --project" };
      options.project = value;
      continue;
    }
    if (token === "--keep-last") {
      const value = tokens[++i];
      const n = value ? parseInt(value, 10) : NaN;
      if (!Number.isFinite(n) || n < 0) return { error: "--keep-last expects a non-negative integer" };
      options.keepLast = n;
      continue;
    }
    if (token === "--older-than") {
      const value = tokens[++i];
      if (!value) return { error: "Missing value for --older-than" };
      const ms = parseDurationToMs(value);
      if (ms == null) return { error: "--older-than expects <number><s|m|h|d>, e.g. 7d" };
      options.olderThanMs = ms;
      continue;
    }
    return { error: `Unknown gc option: ${token}` };
  }

  if (options.project && options.allProjects) {
    return { error: "Use either --project <name> or --all-projects, not both." };
  }

  return { options };
}

function parseRunTimestampMs(runDir: string, runId: string): number {
  const runJsonPath = join(runDir, "run.json");
  try {
    const parsed = JSON.parse(readFileSync(runJsonPath, "utf8"));
    const ts = Date.parse(parsed?.timestamp);
    if (Number.isFinite(ts)) return ts;
  } catch {}

  const idMatch = runId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (idMatch) {
    const iso = `${idMatch[1]}T${idMatch[2]}:${idMatch[3]}:${idMatch[4]}.${idMatch[5]}Z`;
    const fromId = Date.parse(iso);
    if (Number.isFinite(fromId)) return fromId;
  }

  try {
    return statSync(runDir).mtimeMs;
  } catch {
    return 0;
  }
}

export default function abConductorExtension(pi: ExtensionAPI) {
  const cooldownState = new Map<string, number>();

  pi.registerCommand("ab", {
    description: "A/B conductor controls: /ab wizard | status | validate | gc",
    handler: async (args, ctx) => {
      const cmd = (args ?? "").trim();

      if (!cmd || cmd === "wizard") {
        await runAbWizard(ctx);
        return;
      }

      if (cmd === "status" || cmd === "validate") {
        const experiments = loadExperiments(ctx.cwd);
        if (experiments.length === 0) {
          ctx.ui.notify("No A/B experiments found (global or project).", "warning");
          return;
        }
        const lines = experiments.map((e) => `• ${formatExperimentSummary(e)}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (cmd === "gc" || cmd.startsWith("gc ")) {
        const parsed = parseGcOptions(cmd.slice(2).trim());
        if (parsed.help) {
          ctx.ui.notify(
            [
              "Usage: /ab gc [--keep-last N] [--older-than 7d] [--project NAME | --all-projects] [--force]",
              "Default is dry-run (no deletion). Add --force to delete.",
            ].join("\n"),
            "info",
          );
          return;
        }
        if (parsed.error || !parsed.options) {
          ctx.ui.notify(`GC option error: ${parsed.error ?? "invalid options"}`, "warning");
          return;
        }

        const options = parsed.options;
        const runsRoot = join(homedir(), ".pi", "agent", "ab", "runs");
        const defaultProject = basename(ctx.cwd);
        const projectNames = options.allProjects
          ? (() => {
              try {
                return readdirSync(runsRoot, { withFileTypes: true })
                  .filter((d) => d.isDirectory())
                  .map((d) => d.name)
                  .sort();
              } catch {
                return [] as string[];
              }
            })()
          : [options.project ?? defaultProject];

        const now = Date.now();
        const deletions: Array<{ project: string; runId: string; path: string; ageMs: number }> = [];
        let scannedRuns = 0;

        for (const projectName of projectNames) {
          const projectDir = join(runsRoot, projectName);
          let runEntries: Array<{ runId: string; path: string; ts: number }> = [];
          try {
            runEntries = readdirSync(projectDir, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => {
                const runId = d.name;
                const path = join(projectDir, runId);
                return { runId, path, ts: parseRunTimestampMs(path, runId) };
              })
              .sort((a, b) => b.ts - a.ts);
          } catch {
            continue;
          }

          scannedRuns += runEntries.length;
          const protectedSet = new Set(runEntries.slice(0, options.keepLast).map((r) => r.runId));

          for (const run of runEntries) {
            if (protectedSet.has(run.runId)) continue;
            const ageMs = Math.max(0, now - run.ts);
            if (options.olderThanMs != null && ageMs < options.olderThanMs) continue;
            deletions.push({ project: projectName, runId: run.runId, path: run.path, ageMs });
          }
        }

        if (deletions.length === 0) {
          ctx.ui.notify(`AB GC: nothing to delete (scanned ${scannedRuns} runs).`, "info");
          return;
        }

        if (!options.force) {
          const sample = deletions
            .slice(0, 8)
            .map((d) => `• ${d.project}/${d.runId}`)
            .join("\n");
          ctx.ui.notify(
            [
              `AB GC dry-run: would delete ${deletions.length} runs (scanned ${scannedRuns}).`,
              sample,
              deletions.length > 8 ? `…and ${deletions.length - 8} more` : "",
              "Re-run with --force to delete.",
            ]
              .filter(Boolean)
              .join("\n"),
            "warning",
          );
          return;
        }

        let deleted = 0;
        for (const d of deletions) {
          try {
            rmSync(d.path, { recursive: true, force: true });
            deleted += 1;
          } catch {}
        }

        ctx.ui.notify(`AB GC deleted ${deleted}/${deletions.length} runs (scanned ${scannedRuns}).`, "info");
        return;
      }

      ctx.ui.notify("Usage: /ab wizard | status | validate | gc", "warning");
    },
  });

  pi.registerTool({
    name: "ab_setup_wizard",
    label: "A/B Setup Wizard",
    description: "Interactive wizard to create an experiment YAML (global or project scope).",
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
      const loaded = selectExperimentForEdit(ctx.cwd, params, now, cooldownState);
      if (!loaded) {
        return nativeEdit.execute(toolCallId, params, signal, onUpdate);
      }

      const experiment = loaded.experiment;
      cooldownState.set(experiment.id, now);

      const run = createRunContext(ctx.cwd);
      writeRunManifest(run, experiment, {
        source: loaded.source,
        config_path: loaded.path,
        mode: experiment.mode,
        intercepted_tool: "edit",
        intercepted_args: { path: params.path, oldText_len: params.oldText.length, newText_len: params.newText.length },
        lane_harness: process.env.PI_AB_LANE_HARNESS ?? experiment.lane_harness ?? "direct",
        stage: "started",
      });

      const policy = defaultPolicy(experiment);

      try {
        const lanes = await runExperimentLanes(
          loaded,
          run,
          ctx.cwd,
          ctx.sessionManager.getSessionFile(),
          { path: params.path, oldText: params.oldText, newText: params.newText },
          signal,
        );
        writeLaneRecords(run, lanes);

        const winner = await selectWinner(
          loaded,
          run,
          ctx.cwd,
          lanes,
          { path: params.path, oldText: params.oldText, newText: params.newText },
          ctx.model,
          signal,
        );

        const selected = laneById(lanes, winner.winner_lane_id);
        if (!selected || !selected.patch_path || (selected.patch_bytes ?? 0) <= 0) {
          throw new Error(`Winner lane ${winner.winner_lane_id} has no patch.`);
        }

        const apply = await applyPatchToMain(ctx.cwd, selected.patch_path, signal);
        if (!apply.ok) {
          if (policy.on_winner_apply_failure === "fallback_primary_then_fail") {
            const primary = laneById(lanes, getPrimaryLaneId(experiment));
            if (primary?.patch_path && primary.patch_path !== selected.patch_path) {
              const fallbackApply = await applyPatchToMain(ctx.cwd, primary.patch_path, signal);
              if (fallbackApply.ok) {
                const patch = readFileSync(primary.patch_path, "utf8");
                writeRunManifest(run, experiment, {
                  stage: "completed",
                  winner_lane_id: primary.lane_id,
                  winner_mode: `${winner.mode_used} + primary-apply-fallback`,
                  reason: `${winner.reason}; winner apply failed, primary patch applied`,
                  selection_source: "primary_apply_fallback",
                  fallback_reason_code: "winner_apply_failed_primary_apply_succeeded",
                  grading_error_code: winner.grading_error_code,
                });

                return {
                  content: [{ type: "text", text: primary.output_text ?? `Successfully replaced text in ${params.path}.` }],
                  details: {
                    diff: patch,
                    firstChangedLine: undefined,
                    ab: {
                      run_id: run.runId,
                      experiment_id: experiment.id,
                      winner_lane_id: primary.lane_id,
                      mode: winner.mode_used,
                      selection_source: "primary_apply_fallback",
                      fallback_applied: true,
                      fallback_reason_code: "winner_apply_failed_primary_apply_succeeded",
                      grading_error_code: winner.grading_error_code,
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
          grading_error_code: winner.grading_error_code,
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
              mode: winner.mode_used,
              selection_source: winner.selection_source,
              fallback_reason_code: winner.fallback_reason_code,
              grading_error: winner.grading_error,
              grading_error_code: winner.grading_error_code,
            },
          },
        };
      } catch (err: any) {
        const errorText = err?.message ?? String(err);

        if (policy.all_lanes_failed === "fallback_primary") {
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
                  mode: experiment.mode,
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
      }
    },
  });
}
