import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { AbExperiment, LaneRunRecord } from "./types.ts";

export interface RunContext {
  runId: string;
  dir: string;
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function rand4(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function createRunContext(cwd: string): RunContext {
  const project = basename(cwd);
  const runId = `${nowStamp()}-${rand4()}`;
  const dir = join(homedir(), ".pi", "agent", "ab", "runs", project, runId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "lanes"), { recursive: true });
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  return { runId, dir };
}

export function writeRunManifest(
  run: RunContext,
  experiment: AbExperiment,
  payload: Record<string, unknown>,
): void {
  const path = join(run.dir, "run.json");
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};

  writeFileSync(
    path,
    JSON.stringify(
      {
        ...previous,
        run_id: run.runId,
        experiment_id: experiment.id,
        timestamp: new Date().toISOString(),
        ...payload,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function writeLaneRecords(run: RunContext, records: LaneRunRecord[]): void {
  for (const rec of records) {
    writeFileSync(join(run.dir, "lanes", `${rec.lane_id}.json`), JSON.stringify(rec, null, 2), "utf8");
  }
}
