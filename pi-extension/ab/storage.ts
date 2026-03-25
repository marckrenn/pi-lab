import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { AbExperiment, LaneRunRecord } from "./types.ts";

export interface RunContext {
  runId: string;
  dir: string;
  project: string;
  projectDir: string;
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function rand4(): string {
  return Math.random().toString(36).slice(2, 6);
}

function projectRunsLogPath(run: RunContext): string {
  return join(run.projectDir, "runs.jsonl");
}

function appendProjectRunEvent(run: RunContext, entry: Record<string, unknown>): void {
  appendFileSync(projectRunsLogPath(run), `${JSON.stringify(entry)}\n`, "utf8");
}

function currentLaneRecords(run: RunContext): LaneRunRecord[] {
  const lanesDir = join(run.dir, "lanes");
  try {
    return readdirSync(lanesDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .flatMap((name) => {
        try {
          return [JSON.parse(readFileSync(join(lanesDir, name), "utf8")) as LaneRunRecord];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function createRunContext(cwd: string): RunContext {
  const project = basename(cwd);
  const runId = `${nowStamp()}-${rand4()}`;
  const projectDir = join(homedir(), ".pi", "agent", "lab", "runs", project);
  const dir = join(projectDir, runId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "lanes"), { recursive: true });
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  return { runId, dir, project, projectDir };
}

export function writeRunManifest(
  run: RunContext,
  experiment: AbExperiment,
  payload: Record<string, unknown>,
): void {
  const path = join(run.dir, "run.json");
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};

  const manifest = {
    ...previous,
    run_id: run.runId,
    experiment_id: experiment.id,
    timestamp: new Date().toISOString(),
    ...payload,
  };

  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf8");
  appendProjectRunEvent(run, {
    kind: "run_manifest",
    logged_at: new Date().toISOString(),
    project: run.project,
    run_id: run.runId,
    experiment_id: experiment.id,
    run_dir: run.dir,
    manifest,
    lanes: currentLaneRecords(run),
  });
}

export function writeLaneRecords(run: RunContext, records: LaneRunRecord[]): void {
  for (const rec of records) {
    writeFileSync(join(run.dir, "lanes", `${rec.lane_id}.json`), JSON.stringify(rec, null, 2), "utf8");
    appendProjectRunEvent(run, {
      kind: "lane_record",
      logged_at: new Date().toISOString(),
      project: run.project,
      run_id: run.runId,
      lane_id: rec.lane_id,
      record: rec,
    });
  }
}
