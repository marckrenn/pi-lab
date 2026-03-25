import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  AbExperiment,
  BlendWinnerConfig,
  ExecutionStrategy,
  FormulaWinnerConfig,
  LaneConfig,
  LlmWinnerConfig,
  LoadedExperiment,
  WinnerMode,
} from "./types.ts";

function slug(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "lane";
}

type LegacyFlags = {
  target_tool?: boolean;
  winner_mode?: boolean;
  execution_strategy?: boolean;
  timeout_ms?: boolean;
  grading?: boolean;
  selection?: boolean;
  lane_harness?: boolean;
  mode?: boolean;
  trigger_tool?: boolean;
  debug_boolean?: boolean;
  debug_ui?: boolean;
};

export interface ExperimentLoadOptions {
  experimentDirs?: string[];
}

interface ExtraExperimentSource {
  source: string;
  path: string;
}

function laneIdFromRaw(rawLane: any, index: number): string {
  if (typeof rawLane?.id === "string" && rawLane.id.trim()) return rawLane.id.trim();
  if (typeof rawLane?.label === "string" && rawLane.label.trim()) return rawLane.label.trim();
  const firstExt = Array.isArray(rawLane?.extensions) ? rawLane.extensions[0] : undefined;
  if (typeof firstExt === "string" && firstExt.trim()) {
    const name = basename(firstExt).replace(/\.[^.]+$/, "");
    return slug(name);
  }
  return `lane-${index + 1}`;
}

function normalizeLanes(rawLanes: unknown): LaneConfig[] {
  if (!Array.isArray(rawLanes)) return [];
  const lanes = rawLanes.map((rawLane: any, index) => {
    const id = laneIdFromRaw(rawLane, index);
    return {
      id,
      label: typeof rawLane?.label === "string" && rawLane.label.trim() ? rawLane.label.trim() : id,
      baseline: rawLane?.baseline === true,
      model: typeof rawLane?.model === "string" && rawLane.model.trim() ? rawLane.model.trim() : undefined,
      extensions: Array.isArray(rawLane?.extensions) ? rawLane.extensions.filter((v: unknown) => typeof v === "string") : [],
    } satisfies LaneConfig;
  });

  if (lanes.length > 0 && !lanes.some((lane) => lane.baseline)) {
    lanes[0].baseline = true;
  }

  return lanes;
}

function normalizeExperiment(raw: any): AbExperiment {
  const lanes = normalizeLanes(raw?.lanes);
  const legacy: LegacyFlags = {
    target_tool: raw?.target_tool != null,
    winner_mode: raw?.winner_mode != null,
    execution_strategy: raw?.execution_strategy != null,
    timeout_ms: raw?.timeout_ms != null,
    grading: raw?.grading != null,
    selection: raw?.selection != null,
    lane_harness: raw?.lane_harness != null,
    mode: raw?.mode != null,
    trigger_tool: raw?.trigger?.tool != null,
    debug_boolean: typeof raw?.debug === "boolean",
    debug_ui: raw?.debug_ui != null,
  };

  return {
    id: typeof raw?.id === "string" ? raw.id : "",
    enabled: raw?.enabled,
    tool: {
      name: typeof raw?.tool?.name === "string" ? raw.tool.name : "",
      description: typeof raw?.tool?.description === "string" ? raw.tool.description : undefined,
      parameters_schema:
        raw?.tool?.parameters_schema && typeof raw.tool.parameters_schema === "object"
          ? raw.tool.parameters_schema
          : undefined,
    },
    trigger: raw?.trigger && typeof raw.trigger === "object" ? {
      sample_rate: raw.trigger.sample_rate,
      when_path_regex: raw.trigger.when_path_regex,
      when_oldtext_min_chars: raw.trigger.when_oldtext_min_chars,
      cooldown_ms: raw.trigger.cooldown_ms,
    } : undefined,
    execution: raw?.execution && typeof raw.execution === "object" ? {
      strategy: raw.execution.strategy,
      timeout_ms: raw.execution.timeout_ms,
    } : undefined,
    winner: raw?.winner && typeof raw.winner === "object" ? {
      mode: raw.winner.mode,
      hardcoded_lane: raw.winner.hardcoded_lane,
      formula: raw.winner.formula,
      llm: raw.winner.llm,
      blend: raw.winner.blend,
    } : { mode: undefined as any },
    lanes,
    failure_policy: raw?.failure_policy,
    debug: raw?.debug && typeof raw.debug === "object"
      ? { enabled: raw.debug.enabled, ui: raw.debug.ui }
      : typeof raw?.debug === "boolean"
        ? { enabled: raw.debug, ui: raw?.debug_ui }
        : undefined,
    _legacy: legacy,
  } as any;
}

function readExperimentFile(path: string): AbExperiment[] {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.map(normalizeExperiment);
  if (Array.isArray((parsed as any).experiments)) return (parsed as any).experiments.map(normalizeExperiment);
  return [normalizeExperiment(parsed)];
}

function listExperimentFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
}

function normalizeExperimentDir(rawDir: string): string {
  return rawDir.trim();
}

function collectExtraExperimentFiles(cwd: string, dirs?: string[]): ExtraExperimentSource[] {
  if (!dirs || dirs.length === 0) return [];

  const unique = new Set<string>();
  const sources: ExtraExperimentSource[] = [];

  for (const rawDir of dirs) {
    const trimmed = normalizeExperimentDir(rawDir);
    if (!trimmed) continue;
    const absPath = resolve(cwd, trimmed);
    if (unique.has(absPath)) continue;
    unique.add(absPath);
    sources.push({ source: `package:${absPath}`, path: absPath });
  }

  return sources;
}

export function getGlobalLabDir(): string {
  return join(homedir(), ".pi", "agent", "lab");
}

export function getProjectLabDir(cwd: string): string {
  return join(cwd, ".pi", "lab");
}

export function getGlobalExperimentsDir(): string {
  return join(getGlobalLabDir(), "experiments");
}

export function getProjectExperimentsDir(cwd: string): string {
  return join(getProjectLabDir(cwd), "experiments");
}

export function getLegacyProjectExperimentsDir(cwd: string): string {
  return join(cwd, ".pi", "ab", "experiments");
}

export function toolNameOf(experiment: AbExperiment): string {
  return experiment.tool?.name ?? "";
}

export function winnerModeOf(experiment: AbExperiment): WinnerMode {
  return experiment.winner?.mode as WinnerMode;
}

export function executionStrategyOf(experiment: AbExperiment): ExecutionStrategy | undefined {
  return experiment.execution?.strategy;
}

export function timeoutMsOf(experiment: AbExperiment): number {
  return experiment.execution?.timeout_ms ?? 15000;
}

export function debugEnabledOf(experiment: AbExperiment): boolean {
  return experiment.debug?.enabled === true;
}

export function debugUiOf(experiment: AbExperiment): "cmux" | "none" {
  return experiment.debug?.ui ?? "none";
}

export function formulaConfigOf(experiment: AbExperiment): FormulaWinnerConfig {
  return experiment.winner?.formula ?? {};
}

export function llmConfigOf(experiment: AbExperiment): LlmWinnerConfig {
  return experiment.winner?.llm ?? {};
}

export function blendConfigOf(experiment: AbExperiment): BlendWinnerConfig {
  return experiment.winner?.blend ?? {};
}

export function getBaselineLaneId(experiment: AbExperiment): string {
  return experiment.lanes.find((l) => l.baseline)?.id ?? experiment.lanes[0]?.id ?? "";
}

export function getHardcodedWinnerLaneId(experiment: AbExperiment): string {
  return experiment.winner?.hardcoded_lane ?? getBaselineLaneId(experiment);
}

export function loadExperiments(cwd: string, options?: ExperimentLoadOptions): LoadedExperiment[] {
  const globalFiles = listExperimentFiles(getGlobalExperimentsDir());
  const projectFiles = [
    ...listExperimentFiles(getLegacyProjectExperimentsDir(cwd)),
    ...listExperimentFiles(getProjectExperimentsDir(cwd)),
  ];
  const packageSources = collectExtraExperimentFiles(cwd, options?.experimentDirs);

  const merged = new Map<string, LoadedExperiment>();

  for (const path of globalFiles) {
    try {
      for (const experiment of readExperimentFile(path)) {
        if (!experiment?.id) continue;
        merged.set(experiment.id, {
          source: "global",
          path,
          experiment,
          validation: validateExperimentConfig(experiment, path),
        });
      }
    } catch {
      // skip malformed/unavailable config file and continue loading others
    }
  }

  for (const source of packageSources) {
    for (const path of listExperimentFiles(source.path)) {
      try {
        for (const experiment of readExperimentFile(path)) {
          if (!experiment?.id) continue;
          merged.set(experiment.id, {
            source: source.source,
            path,
            experiment,
            validation: validateExperimentConfig(experiment, path),
          });
        }
      } catch {
        // skip malformed/unavailable config file and continue loading others
      }
    }
  }

  for (const path of projectFiles) {
    try {
      for (const experiment of readExperimentFile(path)) {
        if (!experiment?.id) continue;
        merged.set(experiment.id, {
          source: "project",
          path,
          experiment,
          validation: validateExperimentConfig(experiment, path),
        });
      }
    } catch {
      // skip malformed/unavailable config file and continue loading others
    }
  }

  return [...merged.values()];
}

function updateEnabledFlagInRaw(raw: any, experimentId: string, enabled: boolean): boolean {
  if (!raw) return false;

  if (Array.isArray(raw)) {
    let changed = false;
    for (const entry of raw) {
      changed = updateEnabledFlagInRaw(entry, experimentId, enabled) || changed;
    }
    return changed;
  }

  if (Array.isArray(raw.experiments)) {
    let changed = false;
    for (const entry of raw.experiments) {
      changed = updateEnabledFlagInRaw(entry, experimentId, enabled) || changed;
    }
    return changed;
  }

  if (typeof raw.id === "string" && raw.id === experimentId) {
    raw.enabled = enabled;
    return true;
  }

  return false;
}

export function setExperimentEnabled(path: string, experimentId: string, enabled: boolean): {
  found: boolean;
  enabled: boolean;
} {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const found = updateEnabledFlagInRaw(raw, experimentId, enabled);
  if (!found) {
    return { found: false, enabled };
  }

  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return { found: true, enabled };
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

export function validateExperimentConfig(experiment: AbExperiment, _path?: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const strategy = canonicalExecutionStrategy(executionStrategyOf(experiment));
  if (strategy === "invalid") {
    errors.push(`Unsupported execution.strategy '${String(executionStrategyOf(experiment))}'.`);
  }

  if (!toolNameOf(experiment).trim()) {
    errors.push("tool.name is required.");
  }

  const winnerMode = experiment.winner?.mode;
  if (typeof winnerMode !== "string" || !winnerMode.trim()) {
    errors.push("winner.mode is required.");
  }

  if (winnerMode != null && !["hardcoded", "formula", "llm", "blend"].includes(String(winnerMode))) {
    errors.push(`Unsupported winner.mode '${String(winnerMode)}'.`);
  }

  const raw: any = experiment as any;
  const legacy: LegacyFlags = raw?._legacy ?? {};
  if (legacy.target_tool) errors.push("target_tool is no longer supported. Use tool.name.");
  if (legacy.winner_mode) errors.push("winner_mode is no longer supported. Use winner.mode.");
  if (legacy.execution_strategy) errors.push("execution_strategy is no longer supported. Use execution.strategy.");
  if (legacy.timeout_ms) errors.push("timeout_ms is no longer supported. Use execution.timeout_ms.");
  if (legacy.grading) errors.push("grading is no longer supported at the top level. Use winner.llm.");
  if (legacy.selection) errors.push("selection is no longer supported at the top level. Use winner.formula / winner.blend / winner.llm.");
  if (legacy.lane_harness) errors.push("lane_harness is no longer supported in config. Harness is inferred from execution.strategy.");
  if (legacy.mode) errors.push("mode is no longer supported. Use winner.mode.");
  if (legacy.trigger_tool) errors.push("trigger.tool is no longer supported. Route by tool.name only.");
  if (legacy.debug_boolean) errors.push("debug must now be an object: debug.enabled / debug.ui.");
  if (legacy.debug_ui) errors.push("debug_ui is no longer supported at the top level. Use debug.ui.");

  if (!Array.isArray(experiment.lanes) || experiment.lanes.length === 0) {
    errors.push("At least one lane is required.");
  }

  const laneIds = new Set<string>();
  for (const lane of experiment.lanes) {
    if (!lane.id) errors.push("Every lane must resolve to an id.");
    if (lane.id && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lane.id)) {
      errors.push(`Lane id '${lane.id}' contains unsupported characters. Use letters, numbers, '.', '_' or '-'.`);
    }
    if (laneIds.has(lane.id)) errors.push(`Duplicate lane id '${lane.id}'.`);
    laneIds.add(lane.id);
    if (lane.model != null && (typeof lane.model !== "string" || !lane.model.trim())) {
      errors.push(`Lane '${lane.id}' model must be a non-empty string when provided.`);
    }
    if (!Array.isArray(lane.extensions) || lane.extensions.length === 0) {
      errors.push(`Lane '${lane.id}' must have at least one extension.`);
    }
  }

  if (!experiment.lanes.some((lane) => lane.baseline)) {
    warnings.push("No lane marked baseline; first lane will act as baseline fallback.");
  }

  if (winnerMode === "hardcoded") {
    const laneId = experiment.winner?.hardcoded_lane;
    if (typeof laneId !== "string" || !laneId.trim()) {
      errors.push("winner.hardcoded_lane is required for winner.mode='hardcoded'.");
    } else if (!experiment.lanes.some((lane) => lane.id === laneId)) {
      errors.push(`winner.hardcoded_lane '${laneId}' does not match any lane id.`);
    }
  }

  if (winnerMode === "formula" || winnerMode === "blend") {
    const objective = formulaConfigOf(experiment).objective;
    if (objective != null && typeof objective !== "string") {
      errors.push("winner.formula.objective must be a string.");
    }
  }

  const llm = llmConfigOf(experiment);
  if (winnerMode === "llm" || winnerMode === "blend") {
    if (llm.prompt && llm.prompt_file) {
      errors.push("winner.llm.prompt and winner.llm.prompt_file are mutually exclusive.");
    }
    if (!llm.prompt && !llm.prompt_file) {
      warnings.push("No winner.llm.prompt or winner.llm.prompt_file configured; default grading prompt will be used.");
    }
  }

  if (winnerMode === "blend") {
    const blend = blendConfigOf(experiment);
    const hm = blend.mode ?? "llm_tiebreaker";
    if (hm !== "llm_tiebreaker" && hm !== "llm_score") {
      errors.push(`Unsupported winner.blend.mode '${String(hm)}'.`);
    }
    if (blend.formula_weight != null && !Number.isFinite(blend.formula_weight)) {
      errors.push("winner.blend.formula_weight must be a finite number.");
    }
    if (blend.llm_weight != null && !Number.isFinite(blend.llm_weight)) {
      errors.push("winner.blend.llm_weight must be a finite number.");
    }
  }

  if (experiment.trigger?.when_path_regex) {
    try {
      new RegExp(experiment.trigger.when_path_regex);
    } catch {
      errors.push("trigger.when_path_regex must be a valid regular expression.");
    }
  }

  if (experiment.trigger?.when_path_regex && strategy !== "fixed_args") {
    warnings.push("trigger.when_path_regex usually has no effect for lane_single_call/lane_multi_call unless args include path.");
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
  opts?: {
    executionStrategy?: "fixed_args" | "lane_single_call" | "lane_multi_call";
    experimentDirs?: string[];
  },
): LoadedExperiment | null {
  const experiments = loadExperiments(cwd, { experimentDirs: opts?.experimentDirs })
    .filter((e) => e.experiment.enabled !== false)
    .filter((e) => (e.validation?.errors?.length ?? 0) === 0)
    .filter((e) => toolNameOf(e.experiment) === toolName)
    .filter((e) => !opts?.executionStrategy || canonicalExecutionStrategy(executionStrategyOf(e.experiment)) === opts.executionStrategy);

  for (const loaded of experiments) {
    const ex = loaded.experiment;
    const trigger = ex.trigger ?? {};

    if (!samplePass(trigger.sample_rate)) continue;

    if (trigger.when_oldtext_min_chars != null) {
      const oldText = typeof args.oldText === "string" ? args.oldText : "";
      if (oldText.length < trigger.when_oldtext_min_chars) continue;
    }

    if (trigger.when_path_regex) {
      const rawPath = typeof args.path === "string" ? args.path : undefined;
      if (!rawPath) continue;
      const re = new RegExp(trigger.when_path_regex);
      const rel = rawPath.startsWith("/") ? rawPath : resolve(cwd, rawPath).replace(cwd + "/", "");
      if (!re.test(rel) && !re.test(rawPath)) continue;
    }

    const cooldownMs = trigger.cooldown_ms ?? 0;
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
  opts?: { experimentDirs?: string[] },
): LoadedExperiment | null {
  return selectExperimentForTool(cwd, "edit", args as Record<string, unknown>, nowMs, cooldownState, {
    executionStrategy: "fixed_args",
    experimentDirs: opts?.experimentDirs,
  });
}

export function formatExperimentSummary(loaded: LoadedExperiment): string {
  const ex = loaded.experiment;
  const strategy = canonicalExecutionStrategy(executionStrategyOf(ex));
  const validationBadge =
    (loaded.validation?.errors?.length ?? 0) > 0
      ? " [invalid]"
      : (loaded.validation?.warnings?.length ?? 0) > 0
        ? " [warn]"
        : "";
  return `${ex.id} (${loaded.source}, tool=${toolNameOf(ex)}, winner=${winnerModeOf(ex)}, strategy=${strategy}, lanes=${ex.lanes.length}) from ${basename(loaded.path)}${validationBadge}`;
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
