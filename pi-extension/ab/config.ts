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
        merged.set(experiment.id, {
          source: "global",
          path,
          experiment,
          validation: validateExperimentConfig(experiment),
        });
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
        merged.set(experiment.id, {
          source: "project",
          path,
          experiment,
          validation: validateExperimentConfig(experiment),
        });
      }
    } catch {
      // skip malformed/unavailable config file and continue loading others
    }
  }

  return [...merged.values()];
}

export function canonicalExecutionStrategy(
  strategy: unknown,
): "fixed_args" | "lane_single_call" | "lane_multi_call" | "invalid" {
  if (strategy == null) return "fixed_args";
  if (strategy === "fixed_args") return "fixed_args";
  if (strategy === "lane_single_call") return "lane_single_call";
  if (strategy === "lane_multi_call") return "lane_multi_call";
  return "invalid";
}

export function validateExperimentConfig(experiment: AbExperiment): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const strategy = canonicalExecutionStrategy(experiment.execution_strategy);
  if (strategy === "invalid") {
    errors.push(`Unsupported execution_strategy '${String(experiment.execution_strategy)}'.`);
  }

  if (!experiment.target_tool || !experiment.target_tool.trim()) {
    errors.push("target_tool is required.");
  }

  if (!experiment.trigger?.tool || !experiment.trigger.tool.trim()) {
    errors.push("trigger.tool is required.");
  }

  if (experiment.trigger?.tool && experiment.target_tool && experiment.trigger.tool !== experiment.target_tool) {
    warnings.push("trigger.tool differs from target_tool; experiment may never match.");
  }

  if (!Array.isArray(experiment.lanes) || experiment.lanes.length === 0) {
    errors.push("At least one lane is required.");
  }

  const mode = experiment.mode;
  if (mode === "hybrid") {
    const hm = experiment.selection?.hybrid?.mode ?? "llm_tiebreaker";
    if (hm !== "llm_tiebreaker" && hm !== "llm_score") {
      errors.push(`Unsupported hybrid.mode '${String(hm)}'.`);
    }

    if (hm === "llm_score") {
      const dw = experiment.selection?.hybrid?.deterministic_weight;
      const lw = experiment.selection?.hybrid?.llm_weight;
      if (dw != null && !Number.isFinite(dw)) errors.push("selection.hybrid.deterministic_weight must be a finite number.");
      if (lw != null && !Number.isFinite(lw)) errors.push("selection.hybrid.llm_weight must be a finite number.");
    }
  }

  if (experiment.trigger?.when_path_regex && strategy !== "fixed_args") {
    warnings.push("when_path_regex usually has no effect for lane_single_call/lane_multi_call unless args include path.");
  }

  if ((mode === "grading" || mode === "hybrid") && !experiment.grading?.prompt_file && !experiment.selection?.grading?.prompt_file) {
    warnings.push("No grading.prompt_file configured; default grading prompt will be used.");
  }

  return { errors, warnings };
}

function samplePass(sampleRate: number | undefined): boolean {
  if (sampleRate == null) return true;
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  return Math.random() < sampleRate;
}

export function selectExperimentForTool(
  cwd: string,
  toolName: string,
  args: Record<string, unknown>,
  nowMs: number,
  cooldownState: Map<string, number>,
  opts?: { executionStrategy?: "fixed_args" | "lane_single_call" | "lane_multi_call" },
): LoadedExperiment | null {
  const experiments = loadExperiments(cwd)
    .filter((e) => e.experiment.enabled !== false)
    .filter((e) => (e.validation?.errors?.length ?? 0) === 0)
    .filter((e) => e.experiment.target_tool === toolName)
    .filter((e) => e.experiment.trigger?.tool === toolName)
    .filter((e) => !opts?.executionStrategy || canonicalExecutionStrategy(e.experiment.execution_strategy) === opts.executionStrategy);

  for (const loaded of experiments) {
    const ex = loaded.experiment;

    if (!samplePass(ex.trigger.sample_rate)) continue;

    if (ex.trigger.when_oldtext_min_chars != null) {
      const oldText = typeof args.oldText === "string" ? args.oldText : "";
      if (oldText.length < ex.trigger.when_oldtext_min_chars) continue;
    }

    if (ex.trigger.when_path_regex) {
      const rawPath = typeof args.path === "string" ? args.path : undefined;
      if (!rawPath) continue;
      const re = new RegExp(ex.trigger.when_path_regex);
      const rel = rawPath.startsWith("/") ? rawPath : resolve(cwd, rawPath).replace(cwd + "/", "");
      if (!re.test(rel) && !re.test(rawPath)) continue;
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

export function selectExperimentForEdit(
  cwd: string,
  args: { path?: string; oldText?: string },
  nowMs: number,
  cooldownState: Map<string, number>,
): LoadedExperiment | null {
  return selectExperimentForTool(cwd, "edit", args as Record<string, unknown>, nowMs, cooldownState, {
    executionStrategy: "fixed_args",
  });
}

export function formatExperimentSummary(loaded: LoadedExperiment): string {
  const ex = loaded.experiment;
  const strategy = canonicalExecutionStrategy(ex.execution_strategy);
  const validationBadge =
    (loaded.validation?.errors?.length ?? 0) > 0
      ? " [invalid]"
      : (loaded.validation?.warnings?.length ?? 0) > 0
        ? " [warn]"
        : "";
  return `${ex.id} (${loaded.source}, tool=${ex.target_tool}, mode=${ex.mode}, strategy=${strategy}, lanes=${ex.lanes.length}) from ${basename(loaded.path)}${validationBadge}`;
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
