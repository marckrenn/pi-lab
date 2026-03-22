import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import type { AbExperiment, LoadedExperiment } from "./types.ts";

const require = createRequire(import.meta.url);

function parseYamlIfAvailable(raw: string): unknown {
  try {
    const YAML = require("yaml") as { parse: (txt: string) => unknown };
    return YAML.parse(raw);
  } catch {
    throw new Error(
      "YAML config detected but 'yaml' package is not available. Use .json experiment files to avoid npm install, or run npm install.",
    );
  }
}

function readExperimentFile(path: string): AbExperiment[] {
  const raw = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  const parsed = ext === ".json" ? JSON.parse(raw) : parseYamlIfAvailable(raw);

  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed as AbExperiment[];
  if (Array.isArray((parsed as any).experiments)) return (parsed as any).experiments as AbExperiment[];
  return [parsed as AbExperiment];
}

function listExperimentFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml") || f.endsWith(".json"))
    .map((f) => join(dir, f));
}

export function getGlobalExperimentsDir(): string {
  return join(homedir(), ".pi", "agent", "ab", "experiments");
}

export function getProjectExperimentsDir(cwd: string): string {
  return join(cwd, ".pi", "ab", "experiments");
}

export function loadExperiments(cwd: string): LoadedExperiment[] {
  const globalFiles = listExperimentFiles(getGlobalExperimentsDir());
  const projectFiles = listExperimentFiles(getProjectExperimentsDir(cwd));

  const merged = new Map<string, LoadedExperiment>();

  for (const path of globalFiles) {
    try {
      for (const experiment of readExperimentFile(path)) {
        if (!experiment?.id) continue;
        merged.set(experiment.id, { source: "global", path, experiment });
      }
    } catch {
      // skip malformed/unavailable config file and continue loading others
    }
  }

  for (const path of projectFiles) {
    try {
      for (const experiment of readExperimentFile(path)) {
        if (!experiment?.id) continue;
        // project scope overrides global by id
        merged.set(experiment.id, { source: "project", path, experiment });
      }
    } catch {
      // skip malformed/unavailable config file and continue loading others
    }
  }

  return [...merged.values()];
}

function samplePass(sampleRate: number | undefined): boolean {
  if (sampleRate == null) return true;
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  return Math.random() < sampleRate;
}

export function selectExperimentForEdit(
  cwd: string,
  args: { path?: string; oldText?: string },
  nowMs: number,
  cooldownState: Map<string, number>,
): LoadedExperiment | null {
  const experiments = loadExperiments(cwd)
    .filter((e) => e.experiment.enabled !== false)
    .filter((e) => e.experiment.target_tool === "edit")
    .filter((e) => e.experiment.trigger?.tool === "edit");

  for (const loaded of experiments) {
    const ex = loaded.experiment;

    if (!samplePass(ex.trigger.sample_rate)) continue;

    if (ex.trigger.when_oldtext_min_chars != null) {
      const len = (args.oldText ?? "").length;
      if (len < ex.trigger.when_oldtext_min_chars) continue;
    }

    if (ex.trigger.when_path_regex && args.path) {
      const re = new RegExp(ex.trigger.when_path_regex);
      const rel = args.path.startsWith("/") ? args.path : resolve(cwd, args.path).replace(cwd + "/", "");
      if (!re.test(rel) && !re.test(args.path)) continue;
    }

    const cooldownMs = ex.trigger.cooldown_ms ?? 0;
    if (cooldownMs > 0) {
      const last = cooldownState.get(ex.id) ?? 0;
      if (nowMs - last < cooldownMs) continue;
    }

    return loaded;
  }

  return null;
}

export function formatExperimentSummary(loaded: LoadedExperiment): string {
  const ex = loaded.experiment;
  return `${ex.id} (${loaded.source}, mode=${ex.mode}, lanes=${ex.lanes.length}) from ${basename(loaded.path)}`;
}

export function resolveConfiguredPath(value: string, cwd: string, configPath?: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }

  const cwdCandidate = resolve(cwd, trimmed);
  if (existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  const base = configPath ? dirname(configPath) : cwd;
  return resolve(base, trimmed);
}
