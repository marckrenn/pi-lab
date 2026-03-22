import type { AbExperiment, LaneRunRecord } from "./types.ts";

interface MetricExpr {
  direction: "min" | "max";
  metric: string;
}

function parseExpr(expr: string | undefined): MetricExpr | null {
  if (!expr) return null;
  const m = expr.trim().match(/^(min|max)\(([^)]+)\)$/i);
  if (!m) return null;
  return { direction: m[1].toLowerCase() as "min" | "max", metric: m[2].trim() };
}

function laneMetric(lane: LaneRunRecord, metric: string): number {
  switch (metric) {
    case "latency_ms":
      return lane.latency_ms ?? Number.POSITIVE_INFINITY;
    case "total_tokens":
      return lane.total_tokens ?? Number.POSITIVE_INFINITY;
    case "success":
      return lane.status === "success" ? 1 : 0;
    case "patch_bytes":
      return lane.patch_bytes ?? Number.POSITIVE_INFINITY;
    default:
      return Number.NaN;
  }
}

function compareBy(a: LaneRunRecord, b: LaneRunRecord, expr: MetricExpr): number {
  const av = laneMetric(a, expr.metric);
  const bv = laneMetric(b, expr.metric);

  if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
  if (!Number.isFinite(av)) return 1;
  if (!Number.isFinite(bv)) return -1;

  if (av === bv) return 0;
  if (expr.direction === "min") return av < bv ? -1 : 1;
  return av > bv ? -1 : 1;
}

export function getPrimaryLaneId(experiment: AbExperiment): string {
  return experiment.lanes.find((l) => l.primary)?.id ?? experiment.lanes[0]?.id ?? "";
}

export function chooseDeterministicLane(
  experiment: AbExperiment,
  lanes: LaneRunRecord[],
): { laneId: string | null; reason: string } {
  if (lanes.length === 0) {
    return { laneId: null, reason: "no lanes" };
  }

  const successLanes = lanes.filter((l) => l.status === "success");
  const candidates = successLanes.length > 0 ? successLanes : lanes;

  const objective = parseExpr(experiment.selection?.deterministic?.objective ?? "min(latency_ms)");
  const tiebreakers = (experiment.selection?.deterministic?.tie_breakers ?? [])
    .map((s) => parseExpr(s))
    .filter((x): x is MetricExpr => !!x);

  const sorted = [...candidates].sort((a, b) => {
    if (objective) {
      const cmp = compareBy(a, b, objective);
      if (cmp !== 0) return cmp;
    }

    for (const tb of tiebreakers) {
      const cmp = compareBy(a, b, tb);
      if (cmp !== 0) return cmp;
    }

    return a.lane_id.localeCompare(b.lane_id);
  });

  const winner = sorted[0];
  if (!winner) {
    return { laneId: null, reason: "no deterministic winner" };
  }

  const reason = objective
    ? `${objective.direction}(${objective.metric})${tiebreakers.length ? " with tie-breakers" : ""}`
    : "deterministic default order";

  return { laneId: winner.lane_id, reason };
}
