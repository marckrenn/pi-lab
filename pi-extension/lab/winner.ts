import { blendConfigOf, getBaselineLaneId, getHardcodedWinnerLaneId, toolNameOf, winnerModeOf } from "./config.ts";
import { chooseFormulaLane, rankFormulaLanes, type ExtraMetricsByLane } from "./selection.ts";
import { runGradingProcess } from "./grading.ts";
import type { LabExperiment, LaneRunRecord, LoadedExperiment, WinnerSelection } from "./types.ts";

export function defaultPolicy(experiment: LoadedExperiment["experiment"]) {
  const fp = experiment.failure_policy ?? {};
  return {
    on_llm_failure: fp.on_llm_failure ?? "fallback_formula_then_baseline",
    on_winner_apply_failure: fp.on_winner_apply_failure ?? "fallback_baseline_then_fail",
    all_lanes_failed: fp.all_lanes_failed ?? "fail_tool_call",
  };
}

export function successfulLanes(records: LaneRunRecord[], targetTool: string): LaneRunRecord[] {
  if (targetTool === "edit") {
    return records.filter((r) => r.status === "success" && !!r.patch_path && (r.patch_bytes ?? 0) > 0);
  }
  return records.filter((r) => r.status === "success");
}

export function laneById(records: LaneRunRecord[], id: string): LaneRunRecord | undefined {
  return records.find((r) => r.lane_id === id);
}

function formulaFallback(
  loaded: LoadedExperiment,
  records: LaneRunRecord[],
  llmError: { error?: string; error_code?: string },
  modeUsed: WinnerSelection["mode_used"],
): WinnerSelection {
  const experiment = loaded.experiment;
  const policy = defaultPolicy(experiment);
  const baselineLaneId = getBaselineLaneId(experiment);

  const picked = chooseFormulaLane(experiment, records);
  if (picked.laneId && policy.on_llm_failure === "fallback_formula_then_baseline") {
    return {
      winner_lane_id: picked.laneId,
      mode_used: modeUsed,
      reason: `llm fallback: ${picked.reason}`,
      selection_source: "llm_fallback_formula",
      fallback_reason_code: llmError.error_code ?? "llm_no_result",
      llm_error: llmError.error,
      llm_error_code: llmError.error_code,
    };
  }

  return {
    winner_lane_id: baselineLaneId,
    mode_used: modeUsed,
    reason: "llm failed; fallback baseline lane",
    selection_source: "llm_fallback_baseline",
    fallback_reason_code: llmError.error_code ?? "llm_no_result",
    llm_error: llmError.error,
    llm_error_code: llmError.error_code,
  };
}

function blendFinalScoringExperiment(
  experiment: LabExperiment,
  formulaWeight: number,
  llmWeight: number,
): LabExperiment {
  const blend = blendConfigOf(experiment);
  const objective =
    blend.objective ??
    `max({formula_score} * ${formulaWeight} + {llm_score} * ${llmWeight})`;
  const tieBreakers = blend.tie_breakers ?? ["max(llm_score)", "max(formula_score)"];

  return {
    ...experiment,
    winner: {
      ...experiment.winner,
      formula: {
        objective,
        tie_breakers: tieBreakers,
      },
    },
  };
}

async function selectBlendWinner(
  loaded: LoadedExperiment,
  run: { runId: string; dir: string },
  cwd: string,
  records: LaneRunRecord[],
  success: LaneRunRecord[],
  gradingContext: { intercepted_tool: string; intercepted_args: Record<string, unknown> },
  model: { provider?: string; id?: string } | undefined,
  signal?: AbortSignal,
): Promise<WinnerSelection> {
  const experiment = loaded.experiment;
  const blend = blendConfigOf(experiment);
  const blendMode = blend.mode ?? "llm_tiebreaker";

  const ranking = rankFormulaLanes(experiment, success);
  const formulaWinner = ranking.sorted[0];
  if (!formulaWinner) {
    throw new Error("Blend selection found no formula winner.");
  }

  if (blendMode === "llm_tiebreaker") {
    const tieGroup = ranking.sorted.filter((lane) => ranking.compareWithoutIdFallback(lane, formulaWinner) === 0);

    if (tieGroup.length <= 1) {
      return {
        winner_lane_id: formulaWinner.lane_id,
        mode_used: "blend",
        reason: `blend llm_tiebreaker: no formula tie (${ranking.reason})`,
        selection_source: "blend_formula_no_tie",
      };
    }

    const grade = await runGradingProcess(loaded, run, cwd, tieGroup, gradingContext, model, signal);
    const gradeWinner = grade.result?.winner_lane_id;
    const gradeWinnerUsable = gradeWinner ? success.some((r) => r.lane_id === gradeWinner) : false;

    if (grade.result && gradeWinner && gradeWinnerUsable) {
      return {
        winner_lane_id: gradeWinner,
        mode_used: "blend",
        reason: `blend llm_tiebreaker winner among ${tieGroup.length} tied lanes`,
        selection_source: "blend_llm_tiebreaker",
      };
    }

    return formulaFallback(loaded, records, grade, "blend");
  }

  const grade = await runGradingProcess(loaded, run, cwd, success, gradingContext, model, signal);
  const llmScores = new Map<string, number>();

  for (const item of grade.result?.scores ?? []) {
    if (!Number.isFinite(item.score)) continue;
    const clamped = Math.max(0, Math.min(1, item.score));
    llmScores.set(item.lane_id, clamped);
  }

  if (!grade.result || llmScores.size === 0) {
    return formulaFallback(loaded, records, grade, "blend");
  }

  const formulaOrder = ranking.sorted;
  const formulaScores = new Map<string, number>();
  if (formulaOrder.length <= 1) {
    if (formulaOrder[0]) formulaScores.set(formulaOrder[0].lane_id, 1);
  } else {
    const maxIndex = formulaOrder.length - 1;
    formulaOrder.forEach((lane, index) => {
      const score = 1 - index / maxIndex;
      formulaScores.set(lane.lane_id, score);
    });
  }

  const formulaWeight = Number.isFinite(blend.formula_weight) ? Number(blend.formula_weight) : 1;
  const llmWeight = Number.isFinite(blend.llm_weight) ? Number(blend.llm_weight) : 1;

  const extraMetricsByLane: ExtraMetricsByLane = {};
  for (const lane of formulaOrder) {
    extraMetricsByLane[lane.lane_id] = {
      llm_score: llmScores.get(lane.lane_id) ?? 0,
      formula_score: formulaScores.get(lane.lane_id) ?? 0,
    };
  }

  const finalExperiment = blendFinalScoringExperiment(experiment, formulaWeight, llmWeight);
  const finalRanking = rankFormulaLanes(finalExperiment, formulaOrder, extraMetricsByLane);
  const bestLane = finalRanking.sorted[0];

  if (!bestLane) {
    return formulaFallback(loaded, records, {
      error: "blend llm_score produced no winner",
      error_code: "llm_output_invalid_schema",
    }, "blend");
  }

  return {
    winner_lane_id: bestLane.lane_id,
    mode_used: "blend",
    reason: `blend llm_score via formula scoring (${finalRanking.reason})`,
    selection_source: "blend_llm_score",
  };
}

export async function selectWinner(
  loaded: LoadedExperiment,
  run: { runId: string; dir: string },
  cwd: string,
  records: LaneRunRecord[],
  gradingContext: { intercepted_tool: string; intercepted_args: Record<string, unknown> },
  model: { provider?: string; id?: string } | undefined,
  signal?: AbortSignal,
): Promise<WinnerSelection> {
  const experiment = loaded.experiment;
  const policy = defaultPolicy(experiment);
  const baselineLaneId = getBaselineLaneId(experiment);
  const targetTool = toolNameOf(experiment);
  const success = successfulLanes(records, targetTool);
  const winnerMode = winnerModeOf(experiment);

  if (winnerMode === "hardcoded") {
    const hardcodedLaneId = getHardcodedWinnerLaneId(experiment);
    return {
      winner_lane_id: hardcodedLaneId,
      mode_used: "hardcoded",
      reason: "hardcoded mode: configured lane is always selected",
      selection_source: "hardcoded_lane_forced",
    };
  }

  if (success.length === 0) {
    if (policy.all_lanes_failed === "fallback_baseline") {
      return {
        winner_lane_id: baselineLaneId,
        mode_used: "hardcoded",
        reason: "all lanes failed; fallback_baseline policy",
        selection_source: "fallback_baseline",
        fallback_reason_code: "all_lanes_failed",
      };
    }
    throw new Error("All experiment lanes failed.");
  }

  if (winnerMode === "formula") {
    const picked = chooseFormulaLane(experiment, records);
    if (!picked.laneId) throw new Error("Formula selection found no winner.");
    return {
      winner_lane_id: picked.laneId,
      mode_used: "formula",
      reason: picked.reason,
      selection_source: "formula",
    };
  }

  if (winnerMode === "blend") {
    return selectBlendWinner(loaded, run, cwd, records, success, gradingContext, model, signal);
  }

  const grade = await runGradingProcess(loaded, run, cwd, records, gradingContext, model, signal);
  const gradeWinner = grade.result?.winner_lane_id;
  const gradeWinnerUsable = gradeWinner ? success.some((r) => r.lane_id === gradeWinner) : false;

  if (grade.result && gradeWinner && gradeWinnerUsable) {
    return {
      winner_lane_id: gradeWinner,
      mode_used: "llm",
      reason: "llm grading winner",
      selection_source: "llm",
    };
  }

  const llmFailureCode = grade.error_code ?? (gradeWinner ? "llm_winner_not_successful" : "llm_no_result");

  if (policy.on_llm_failure === "fallback_formula_then_baseline") {
    const picked = chooseFormulaLane(experiment, records);
    if (picked.laneId) {
      return {
        winner_lane_id: picked.laneId,
        mode_used: "llm-fallback-formula",
        reason: `llm fallback: ${picked.reason}`,
        selection_source: "llm_fallback_formula",
        fallback_reason_code: llmFailureCode,
        llm_error: grade.error,
        llm_error_code: grade.error_code,
      };
    }
  }

  return {
    winner_lane_id: baselineLaneId,
    mode_used: "llm-fallback-baseline",
    reason: "llm failed; fallback baseline lane",
    selection_source: "llm_fallback_baseline",
    fallback_reason_code: llmFailureCode,
    llm_error: grade.error,
    llm_error_code: grade.error_code,
  };
}
