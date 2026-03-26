import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getGlobalLabDir, getProjectLabDir } from "./config.ts";

export interface LabGcOptions {
  keepLast: number;
  olderThanMs?: number;
  force: boolean;
  project?: string;
  allProjects: boolean;
}

export interface LabGcResult {
  level: "info" | "warning" | "error";
  message: string;
}

function parseDurationToMs(value: string): number | null {
  const m = value.trim().match(/^(\d+)([smhd])$/i);
  if (!m) return null;
  const amount = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const factor = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return amount * factor;
}

function parseGcOptions(args: string): { options?: LabGcOptions; error?: string; help?: boolean } {
  const tokens = args.split(/\s+/).filter(Boolean);
  const options: LabGcOptions = { keepLast: 10, force: false, allProjects: false };

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

export function runLabGcCommand(args: string, cwd: string): LabGcResult {
  const parsed = parseGcOptions(args.trim());
  if (parsed.help) {
    return {
      level: "info",
      message:
        "Usage: /lab gc [--keep-last N] [--older-than 7d] [--project NAME | --all-projects] [--force]\n" +
        "Default is dry-run (no deletion). Add --force to delete.",
    };
  }

  if (parsed.error || !parsed.options) {
    return { level: "warning", message: `GC option error: ${parsed.error ?? "invalid options"}` };
  }

  const options = parsed.options;
  const globalLabDir = getGlobalLabDir();
  const defaultProject = basename(cwd);

  const projectScopes = options.allProjects
    ? (() => {
        try {
          return readdirSync(globalLabDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name !== "experiments")
            .map((d) => ({ project: d.name, dir: join(globalLabDir, d.name) }))
            .sort((a, b) => a.project.localeCompare(b.project));
        } catch {
          return [] as Array<{ project: string; dir: string }>;
        }
      })()
    : options.project
      ? [{ project: options.project, dir: join(globalLabDir, options.project) }]
      : [{ project: defaultProject, dir: getProjectLabDir(cwd) }];

  const now = Date.now();
  const deletions: Array<{ project: string; runId: string; path: string; ageMs: number }> = [];
  let scannedRuns = 0;

  for (const scope of projectScopes) {
    let runEntries: Array<{ runId: string; path: string; ts: number }> = [];
    try {
      runEntries = readdirSync(scope.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== "experiments")
        .map((d) => {
          const runId = d.name;
          const path = join(scope.dir, runId);
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
      deletions.push({ project: scope.project, runId: run.runId, path: run.path, ageMs });
    }
  }

  if (deletions.length === 0) {
    return { level: "info", message: `Lab GC: nothing to delete (scanned ${scannedRuns} runs).` };
  }

  if (!options.force) {
    const sample = deletions
      .slice(0, 8)
      .map((d) => `• ${d.project}/${d.runId}`)
      .join("\n");
    return {
      level: "warning",
      message: [
        `Lab GC dry-run: would delete ${deletions.length} runs (scanned ${scannedRuns}).`,
        sample,
        deletions.length > 8 ? `…and ${deletions.length - 8} more` : "",
        "Re-run with --force to delete.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  let deleted = 0;
  for (const d of deletions) {
    try {
      rmSync(d.path, { recursive: true, force: true });
      deleted += 1;
    } catch {}
  }

  return {
    level: "info",
    message: `Lab GC deleted ${deleted}/${deletions.length} runs (scanned ${scannedRuns}).`,
  };
}
