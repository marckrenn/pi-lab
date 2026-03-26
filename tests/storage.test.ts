import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { createRunContext, writeLaneRecords, writeRunManifest } from "../pi-extension/lab/storage.ts";
import type { LabExperiment, LaneRunRecord } from "../pi-extension/lab/types.ts";

const originalHome = process.env.HOME;
let cleanupProjectDir: string | undefined;

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

afterEach(() => {
  if (originalHome == null) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (cleanupProjectDir) {
    rmSync(cleanupProjectDir, { recursive: true, force: true });
    cleanupProjectDir = undefined;
  }
});

describe("project run jsonl logging", () => {
  test("appends run and lane events to project runs.jsonl and per-experiment runs.jsonl", () => {
    const fakeHome = createTempDir("pi-lab-home-");
    const cwd = createTempDir("pi-lab-project-");
    process.env.HOME = fakeHome;

    const run = createRunContext(cwd, "example-exp");
    cleanupProjectDir = run.projectDir;
    const experiment: LabExperiment = {
      id: "example-exp",
      tool: { name: "edit" },
      winner: { mode: "formula" },
      lanes: [{ id: "baseline", baseline: true, extensions: ["./lane.ts"] }],
    };

    writeRunManifest(run, experiment, {
      stage: "started",
      configured_winner_mode: "formula",
      intercepted_tool: "edit",
    });

    const lane: LaneRunRecord = {
      lane_id: "baseline",
      status: "success",
      latency_ms: 12,
      output_text: "ok",
      tool_call_count: 3,
      total_tool_call_count: 3,
      custom_tool_call_count: 2,
    };
    writeLaneRecords(run, [lane]);

    expect(run.dir).toBe(join(run.projectDir, "experiments", "example-exp", "runs", run.runId));

    const topLevelLogPath = join(run.projectDir, "runs.jsonl");
    const topLevelLines = readFileSync(topLevelLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    const experimentLogPath = join(run.projectDir, "experiments", "example-exp", "runs.jsonl");
    const experimentLines = readFileSync(experimentLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    expect(topLevelLines).toHaveLength(2);
    expect(experimentLines).toHaveLength(2);
    expect(topLevelLines[0].kind).toBe("run_manifest");
    expect(topLevelLines[0].run_id).toBe(run.runId);
    expect(topLevelLines[0].project).toBe(run.project);
    expect(topLevelLines[0].manifest.experiment_id).toBe("example-exp");
    expect(topLevelLines[0].manifest.stage).toBe("started");

    expect(topLevelLines[1].kind).toBe("lane_record");
    expect(topLevelLines[1].lane_id).toBe("baseline");
    expect(topLevelLines[1].record.status).toBe("success");
    expect(topLevelLines[1].record.tool_call_count).toBe(3);
    expect(topLevelLines[1].record.custom_tool_call_count).toBe(2);
    expect(experimentLines).toEqual(topLevelLines);
  });
});
