import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { createRunContext, writeLaneRecords, writeRunManifest } from "../pi-extension/ab/storage.ts";
import type { AbExperiment, LaneRunRecord } from "../pi-extension/ab/types.ts";

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
  test("appends run and lane events to project runs.jsonl", () => {
    const fakeHome = createTempDir("pi-lab-home-");
    const cwd = createTempDir("pi-lab-project-");
    process.env.HOME = fakeHome;

    const run = createRunContext(cwd);
    cleanupProjectDir = run.projectDir;
    const experiment: AbExperiment = {
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
    };
    writeLaneRecords(run, [lane]);

    const logPath = join(run.projectDir, "runs.jsonl");
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0].kind).toBe("run_manifest");
    expect(lines[0].run_id).toBe(run.runId);
    expect(lines[0].project).toBe(run.project);
    expect(lines[0].manifest.experiment_id).toBe("example-exp");
    expect(lines[0].manifest.stage).toBe("started");

    expect(lines[1].kind).toBe("lane_record");
    expect(lines[1].lane_id).toBe("baseline");
    expect(lines[1].record.status).toBe("success");
  });
});
