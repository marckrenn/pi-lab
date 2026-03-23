export type AbMode = "shadow" | "deterministic" | "grading" | "hybrid";
export type ExecutionStrategy = "fixed_args" | "lane_single_call" | "lane_multi_call";

export interface TriggerPolicy {
  tool: string;
  sample_rate?: number;
  when_path_regex?: string;
  when_oldtext_min_chars?: number;
  cooldown_ms?: number;
}

export interface FailurePolicy {
  on_lane_timeout?: "exclude_continue" | "abort_all";
  on_lane_crash?: "exclude_continue" | "abort_all";
  on_grading_failure?: "fallback_deterministic_then_shadow" | "fallback_shadow";
  on_winner_apply_failure?: "fallback_primary_then_fail" | "fail";
  all_lanes_failed?: "fail_tool_call" | "fallback_primary";
}

export interface LaneConfig {
  id: string;
  primary?: boolean;
  extensions: string[];
}

export interface DeterministicSelection {
  objective: string;
  tie_breakers?: string[];
}

export interface GradingConfig {
  execution?: "process" | "inline";
  model?: string;
  timeout_ms?: number;
  prompt_file?: string;
  include?: {
    outputs?: boolean;
    metrics?: boolean;
    patches?: boolean;
    tool_calls?: boolean;
  };
}

export interface HybridSelection {
  mode?: "llm_tiebreaker" | "llm_score";
  deterministic_weight?: number;
  llm_weight?: number;
  final_objective?: string;
  final_tie_breakers?: string[];
}

export interface AbExperiment {
  id: string;
  enabled?: boolean;
  target_tool: string;
  trigger: TriggerPolicy;
  mode: AbMode;
  execution_strategy?: ExecutionStrategy;
  lanes: LaneConfig[];
  timeout_ms?: number;
  debug?: boolean;
  debug_ui?: "cmux" | "none";
  lane_harness?: "direct" | "pi_prompt";
  selection?: {
    deterministic?: DeterministicSelection;
    grading?: GradingConfig;
    hybrid?: HybridSelection;
  };
  grading?: GradingConfig;
  failure_policy?: FailurePolicy;
}

export interface LoadedExperiment {
  source: "global" | "project";
  path: string;
  experiment: AbExperiment;
  validation?: {
    errors: string[];
    warnings: string[];
  };
}

export type LaneStatus = "not_run_mvp" | "success" | "error" | "timeout";

export interface LaneRunRecord {
  lane_id: string;
  status: LaneStatus;
  latency_ms?: number;
  error?: string;
  output_text?: string;
  total_tokens?: number;
  patch_path?: string;
  patch_bytes?: number;
  session_file?: string;
  worktree_path?: string;
  process_exit_code?: number;
  lane_harness_used?: "direct" | "pi_prompt";
}

export interface WinnerSelection {
  winner_lane_id: string;
  mode_used: AbMode | "grading-fallback-deterministic" | "grading-fallback-shadow";
  reason: string;
  selection_source?: string;
  fallback_reason_code?: string;
  grading_error?: string;
  grading_error_code?: string;
}
