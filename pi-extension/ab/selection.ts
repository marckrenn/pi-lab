import type { AbExperiment, LaneRunRecord } from "./types.ts";
import { formulaConfigOf, getBaselineLaneId } from "./config.ts";

type Direction = "min" | "max";

interface ScoreExpr {
  direction: Direction;
  body: string;
  kind: "metric" | "formula";
}

export type ExtraMetricsByLane = Record<string, Record<string, number>>;

function parseExpr(expr: string | undefined): ScoreExpr | null {
  if (!expr) return null;
  const m = expr.trim().match(/^(min|max)\(([\s\S]+)\)$/i);
  if (!m) return null;

  const direction = m[1].toLowerCase() as Direction;
  const body = m[2].trim();
  if (!body) return null;

  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(body)) {
    return { direction, body, kind: "metric" };
  }

  return { direction, body, kind: "formula" };
}

function laneMetric(lane: LaneRunRecord, metric: string, extraMetricsByLane?: ExtraMetricsByLane): number {
  const extra = extraMetricsByLane?.[lane.lane_id]?.[metric];
  if (typeof extra === "number" && Number.isFinite(extra)) {
    return extra;
  }

  switch (metric) {
    case "latency_ms":
      return lane.latency_ms ?? Number.POSITIVE_INFINITY;
    case "total_tokens":
      return lane.total_tokens ?? Number.POSITIVE_INFINITY;
    case "success":
    case "success_one_zero":
      return lane.status === "success" ? 1 : 0;
    case "error":
    case "error_one_zero":
      return lane.status === "error" ? 1 : 0;
    case "timeout":
    case "timeout_one_zero":
      return lane.status === "timeout" ? 1 : 0;
    case "patch_bytes":
      return lane.patch_bytes ?? Number.POSITIVE_INFINITY;
    case "process_exit_code":
      return lane.process_exit_code ?? Number.POSITIVE_INFINITY;
    default:
      return Number.NaN;
  }
}

function evaluateFormula(formula: string, lane: LaneRunRecord, extraMetricsByLane?: ExtraMetricsByLane): number {
  const substituted = formula.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_full, metricName: string) => {
    const value = laneMetric(lane, metricName, extraMetricsByLane);
    return Number.isFinite(value) ? String(value) : "(0/0)";
  });

  if (substituted.includes("**")) return Number.NaN;
  if (!/^[0-9+\-*/().\s]+$/.test(substituted)) return Number.NaN;

  try {
    const value = Function(`"use strict"; return (${substituted});`)();
    return typeof value === "number" ? value : Number(value);
  } catch {
    return Number.NaN;
  }
}

function exprValue(lane: LaneRunRecord, expr: ScoreExpr, extraMetricsByLane?: ExtraMetricsByLane): number {
  if (expr.kind === "metric") {
    return laneMetric(lane, expr.body, extraMetricsByLane);
  }
  return evaluateFormula(expr.body, lane, extraMetricsByLane);
}

function compareBy(a: LaneRunRecord, b: LaneRunRecord, expr: ScoreExpr, extraMetricsByLane?: ExtraMetricsByLane): number {
  const av = exprValue(a, expr, extraMetricsByLane);
  const bv = exprValue(b, expr, extraMetricsByLane);

  if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
  if (!Number.isFinite(av)) return 1;
  if (!Number.isFinite(bv)) return -1;

  if (av === bv) return 0;
  if (expr.direction === "min") return av < bv ? -1 : 1;
  return av > bv ? -1 : 1;
}

export { getBaselineLaneId };

export interface FormulaRanking {
  candidates: LaneRunRecord[];
  sorted: LaneRunRecord[];
  reason: string;
  compare: (a: LaneRunRecord, b: LaneRunRecord) => number;
  compareWithoutIdFallback: (a: LaneRunRecord, b: LaneRunRecord) => number;
}

export function rankFormulaLanes(
  experiment: AbExperiment,
  lanes: LaneRunRecord[],
  extraMetricsByLane?: ExtraMetricsByLane,
): FormulaRanking {
  const successLanes = lanes.filter((l) => l.status === "success");
  const candidates = successLanes.length > 0 ? successLanes : lanes;

  const formula = formulaConfigOf(experiment);
  const objective = parseExpr(formula.objective ?? "min(latency_ms)");
  const tiebreakers = (formula.tie_breakers ?? [])
    .map((s) => parseExpr(s))
    .filter((x): x is ScoreExpr => !!x);

  const compareWithoutIdFallback = (a: LaneRunRecord, b: LaneRunRecord): number => {
    if (objective) {
      const cmp = compareBy(a, b, objective, extraMetricsByLane);
      if (cmp !== 0) return cmp;
    }

    for (const tb of tiebreakers) {
      const cmp = compareBy(a, b, tb, extraMetricsByLane);
      if (cmp !== 0) return cmp;
    }

    return 0;
  };

  const compare = (a: LaneRunRecord, b: LaneRunRecord): number => {
    const cmp = compareWithoutIdFallback(a, b);
    if (cmp !== 0) return cmp;
    return a.lane_id.localeCompare(b.lane_id);
  };

  const sorted = [...candidates].sort(compare);
  const reason = objective
    ? `${objective.direction}(${objective.body})${tiebreakers.length ? " with tie-breakers" : ""}`
    : "formula default order";

  return { candidates, sorted, reason, compare, compareWithoutIdFallback };
}

export function chooseFormulaLane(
  experiment: AbExperiment,
  lanes: LaneRunRecord[],
): { laneId: string | null; reason: string } {
  if (lanes.length === 0) {
    return { laneId: null, reason: "no lanes" };
  }

  const ranking = rankFormulaLanes(experiment, lanes);
  const winner = ranking.sorted[0];
  if (!winner) {
    return { laneId: null, reason: "no formula winner" };
  }

  return { laneId: winner.lane_id, reason: ranking.reason };
}
