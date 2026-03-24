import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DIRECT_HARNESS_FALLBACK_REASONS,
  DirectLaneHarnessError,
  directHarnessFallbackReasonForError,
  loadLaneToolsDirect,
} from "../pi-extension/ab/runner.ts";
import type { LaneConfig } from "../pi-extension/ab/types.ts";

describe("direct lane harness extension compatibility checks", () => {
  const tmpRoots: string[] = [];

  const createTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-runner-test-"));
    tmpRoots.push(dir);
    return dir;
  };

  afterEach(() => {
    while (tmpRoots.length > 0) {
      const dir = tmpRoots.pop();
      if (!dir) continue;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadLaneToolsDirect fails fast when unsupported pi API is accessed", async () => {
    const dir = createTempDir();
    const laneDir = join(dir, "lanes");
    mkdirSync(laneDir);

    const extensionPath = join(laneDir, "unsupported.ts");
    writeFileSync(
      extensionPath,
      [
        "export default function lane(pi) {",
        "  pi.registerTool({",
        "    name: 'direct-test',",
        "    description: 'direct harness unsupported API detection',",
        "    parameters: { type: 'object', additionalProperties: false, properties: {} },",
        "    async execute(toolCallId, params) {",
        "      return { content: [{ type: 'text', text: 'ok' }] };",
        "    },",
        "  });",
        "  pi.on('session_start', () => {});",
        "}",
      ].join("\n"),
      "utf8",
    );

    const lane: LaneConfig = {
      id: "A",
      baseline: true,
      extensions: [extensionPath],
    };

    await expect(loadLaneToolsDirect(lane, dir, dir, join(dir, "worktree"))).rejects.toBeInstanceOf(DirectLaneHarnessError);
  });

  test("direct harness fallback reason helper returns explicit reason for unsupported API", () => {
    const err = new DirectLaneHarnessError(
      "unsupported api",
      DIRECT_HARNESS_FALLBACK_REASONS.unsupportedExtensionApi,
    );

    expect(directHarnessFallbackReasonForError(err)).toBe(DIRECT_HARNESS_FALLBACK_REASONS.unsupportedExtensionApi);
    expect(directHarnessFallbackReasonForError(new Error("generic"))).toBe(DIRECT_HARNESS_FALLBACK_REASONS.failed);
  });
});
