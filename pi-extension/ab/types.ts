export type WinnerMode = "hardcoded" | "formula" | "llm" | "blend";
export type ExecutionStrategy = "fixed_args" | "lane_single_call" | "lane_multi_call";

export interface TriggerPolicy {
  sample_rate?: number;
  when_path_regex?: string;
  when_oldtext_min_chars?: number;
  cooldown_ms?: number;
}

export interface FailurePolicy {
  on_lane_timeout?: "exclude_continue" | "abort_all";
  on_lane_crash?: "exclude_continue" | "abort_all";
  on_llm_failure?: "fallback_formula_then_baseline" | "fallback_baseline";
  on_winner_apply_failure?: "fallback_baseline_then_fail" | "fail";
  all_lanes_failed?: "fail_tool_call" | "fallback_baseline";
}

export interface LaneConfig {
  id: string;
  label?: string;
  baseline?: boolean;
  extensions: string[];
}

export interface FormulaWinnerConfig {
  objective?: string;
  tie_breakers?: string[];
}

export interface LlmWinnerConfig {
  execution?: "process" | "inline";
  model?: string;
  timeout_ms?: number;
  prompt?: string;
  prompt_file?: string;
  include_tool_calls?: boolean;
}

export interface BlendWinnerConfig {
  mode?: "llm_tiebreaker" | "llm_score";
  formula_weight?: number;
  llm_weight?: number;
  objective?: string;
  tie_breakers?: string[];
}

export interface WinnerConfig {
  mode: WinnerMode;
  hardcoded_lane?: string;
  formula?: FormulaWinnerConfig;
  llm?: LlmWinnerConfig;
  blend?: BlendWinnerConfig;
}

export interface ToolConfig {
  name: string;
}

export interface ExecutionConfig {
  strategy?: ExecutionStrategy;
  timeout_ms?: number;
}

export interface DebugConfig {
  enabled?: boolean;
  ui?: "cmux" | "none";
}

export interface AbExperiment {
  id: string;
  enabled?: boolean;
  tool: ToolConfig;
  trigger?: TriggerPolicy;
  execution?: ExecutionConfig;
  winner: WinnerConfig;
  lanes: LaneConfig[];
  failure_policy?: FailurePolicy;
  debug?: DebugConfig;
}

export type LaneStatus = "not_run_mvp" | "success" | "error" | "timeout";

export interface LoadedExperiment {
  source: string;
  path: string;
  experiment: AbExperiment;
  validation?: {
    errors: string[];
    warnings: string[];
  };
}

export type LaneHarnessFallbackReason = "direct_harness_failed" | "direct_harness_unsupported_extension_api";

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
  lane_harness_requested?: "direct" | "pi_prompt";
  lane_harness_fallback_reason?: LaneHarnessFallbackReason;
}

export interface WinnerSelection {
  winner_lane_id: string;
  mode_used: WinnerMode | "llm-fallback-formula" | "llm-fallback-baseline";
  reason: string;
  selection_source?: string;
  fallback_reason_code?: string;
  llm_error?: string;
  llm_error_code?: string;
}
