import { chooseDeterministicLane, getPrimaryLaneId, rankDeterministicLanes, type ExtraMetricsByLane } from "./selection.ts";
import { runGradingProcess } from "./grading.ts";
import type { AbExperiment, LaneRunRecord, LoadedExperiment, WinnerSelection } from "./types.ts";

export function defaultPolicy(experiment: LoadedExperiment["experiment"]) {
  const fp = experiment.failure_policy ?? {};
  return {
    on_grading_failure: fp.on_grading_failure ?? "fallback_deterministic_then_shadow",
    on_winner_apply_failure: fp.on_winner_apply_failure ?? "fallback_primary_then_fail",
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

function deterministicFallback(
  loaded: LoadedExperiment,
  records: LaneRunRecord[],
  gradeError: { error?: string; error_code?: string },
  modeUsed: WinnerSelection["mode_used"],
): WinnerSelection {
  const experiment = loaded.experiment;
  const policy = defaultPolicy(experiment);
  const primaryLaneId = getPrimaryLaneId(experiment);

  const picked = chooseDeterministicLane(experiment, records);
  if (picked.laneId && policy.on_grading_failure === "fallback_deterministic_then_shadow") {
    return {
      winner_lane_id: picked.laneId,
      mode_used: modeUsed,
      reason: `grading fallback: ${picked.reason}`,
      selection_source: "grading_fallback_deterministic",
      fallback_reason_code: gradeError.error_code ?? "grading_no_result",
      grading_error: gradeError.error,
      grading_error_code: gradeError.error_code,
    };
  }

  return {
    winner_lane_id: primaryLaneId,
    mode_used: modeUsed,
    reason: "grading failed; fallback shadow primary",
    selection_source: "grading_fallback_shadow",
    fallback_reason_code: gradeError.error_code ?? "grading_no_result",
    grading_error: gradeError.error,
    grading_error_code: gradeError.error_code,
  };
}

function hybridFinalScoringExperiment(
  experiment: AbExperiment,
  deterministicWeight: number,
  llmWeight: number,
): AbExperiment {
  const hybrid = experiment.selection?.hybrid ?? {};
  const objective =
    hybrid.final_objective ??
    `max({deterministic_score} * ${deterministicWeight} + {llm_score} * ${llmWeight})`;
  const tieBreakers = hybrid.final_tie_breakers ?? ["max(llm_score)", "max(deterministic_score)"];

  return {
    ...experiment,
    selection: {
      ...experiment.selection,
      deterministic: {
        objective,
        tie_breakers: tieBreakers,
      },
    },
  };
}

async function selectHybridWinner(
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
  const hybrid = experiment.selection?.hybrid ?? {};
  const hybridMode = hybrid.mode ?? "llm_tiebreaker";

  const ranking = rankDeterministicLanes(experiment, success);
  const deterministicWinner = ranking.sorted[0];
  if (!deterministicWinner) {
    throw new Error("Hybrid selection found no deterministic winner.");
  }

  if (hybridMode === "llm_tiebreaker") {
    const tieGroup = ranking.sorted.filter((lane) => ranking.compareWithoutIdFallback(lane, deterministicWinner) === 0);

    if (tieGroup.length <= 1) {
      return {
        winner_lane_id: deterministicWinner.lane_id,
        mode_used: "hybrid",
        reason: `hybrid llm_tiebreaker: no deterministic tie (${ranking.reason})`,
        selection_source: "hybrid_deterministic_no_tie",
      };
    }

    const grade = await runGradingProcess(loaded, run, cwd, tieGroup, gradingContext, model, signal);
    const gradeWinner = grade.result?.winner_lane_id;
    const gradeWinnerUsable = gradeWinner ? success.some((r) => r.lane_id === gradeWinner) : false;

    if (grade.result && gradeWinner && gradeWinnerUsable) {
      return {
        winner_lane_id: gradeWinner,
        mode_used: "hybrid",
        reason: `hybrid llm_tiebreaker winner among ${tieGroup.length} tied lanes`,
        selection_source: "hybrid_llm_tiebreaker",
      };
    }

    return deterministicFallback(loaded, records, grade, "hybrid");
  }

  // hybrid llm_score mode
  const grade = await runGradingProcess(loaded, run, cwd, success, gradingContext, model, signal);
  const llmScores = new Map<string, number>();

  for (const item of grade.result?.scores ?? []) {
    if (!Number.isFinite(item.score)) continue;
    const clamped = Math.max(0, Math.min(1, item.score));
    llmScores.set(item.lane_id, clamped);
  }

  if (!grade.result || llmScores.size === 0) {
    return deterministicFallback(loaded, records, grade, "hybrid");
  }

  const deterministicOrder = ranking.sorted;
  const deterministicScores = new Map<string, number>();
  if (deterministicOrder.length <= 1) {
    if (deterministicOrder[0]) deterministicScores.set(deterministicOrder[0].lane_id, 1);
  } else {
    const maxIndex = deterministicOrder.length - 1;
    deterministicOrder.forEach((lane, index) => {
      const score = 1 - index / maxIndex;
      deterministicScores.set(lane.lane_id, score);
    });
  }

  const deterministicWeight = Number.isFinite(hybrid.deterministic_weight) ? Number(hybrid.deterministic_weight) : 1;
  const llmWeight = Number.isFinite(hybrid.llm_weight) ? Number(hybrid.llm_weight) : 1;

  const extraMetricsByLane: ExtraMetricsByLane = {};
  for (const lane of deterministicOrder) {
    extraMetricsByLane[lane.lane_id] = {
      llm_score: llmScores.get(lane.lane_id) ?? 0,
      deterministic_score: deterministicScores.get(lane.lane_id) ?? 0,
    };
  }

  const finalExperiment = hybridFinalScoringExperiment(experiment, deterministicWeight, llmWeight);
  const finalRanking = rankDeterministicLanes(finalExperiment, deterministicOrder, extraMetricsByLane);
  const bestLane = finalRanking.sorted[0];

  if (!bestLane) {
    return deterministicFallback(loaded, records, {
      error: "hybrid llm_score produced no winner",
      error_code: "grading_output_invalid_schema",
    }, "hybrid");
  }

  return {
    winner_lane_id: bestLane.lane_id,
    mode_used: "hybrid",
    reason: `hybrid llm_score via template scoring (${finalRanking.reason})`,
    selection_source: "hybrid_llm_score",
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
  const primaryLaneId = getPrimaryLaneId(experiment);
  const success = successfulLanes(records, experiment.target_tool);

  if (experiment.winner_mode === "shadow") {
    return {
      winner_lane_id: primaryLaneId,
      mode_used: "shadow",
      reason: "shadow mode: primary lane is always selected",
      selection_source: "shadow_primary_forced",
    };
  }

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

  if (experiment.winner_mode === "deterministic") {
    const picked = chooseDeterministicLane(experiment, records);
    if (!picked.laneId) throw new Error("Deterministic selection found no winner.");
    return {
      winner_lane_id: picked.laneId,
      mode_used: "deterministic",
      reason: picked.reason,
      selection_source: "deterministic",
    };
  }

  if (experiment.winner_mode === "hybrid") {
    return selectHybridWinner(loaded, run, cwd, records, success, gradingContext, model, signal);
  }

  // grading mode
  const grade = await runGradingProcess(loaded, run, cwd, records, gradingContext, model, signal);
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
