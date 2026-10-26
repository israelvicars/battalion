import type { Envelope } from "../core/envelope.ts";

export type AdapterManifest = {
  id: string;
  ability: "cli" | "api" | "browser" | "computer_use";
  capabilities: string[];
  isolation: string;
  cost_class: string;
  streaming: "full" | "final-only";
  notes: string;
  plan_ends?: string;
};

export type AuthState = {
  state: "ok" | "needs_login" | "needs_key" | "expired";
  hint: string;
};

export type TokenUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_cost_usd?: number;
};

export type NormalizedEvent =
  | { type: "started"; run_id: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; detail?: unknown }
  | { type: "tool_result"; name: string; detail?: unknown }
  | { type: "file_changed"; path: string }
  | { type: "needs_approval"; reason: string }
  | ({ type: "cost"; cost_usd: number } & Partial<TokenUsage>)
  | { type: "error"; reason: string; message: string }
  | { type: "finished"; exit: number | null };

export type AdapterResult = {
  text: string;
  artifacts: string[];
  exit: number | null;
  usage?: TokenUsage;
  changed_files?: number;
};

export type AdapterUsage = {
  cost_usd: number;
  quota: "unknown" | string | number;
  plan_ends?: string;
};

export type CancelResult = { stopped: boolean };

export interface Adapter {
  manifest(): AdapterManifest;
  authState(): Promise<AuthState>;
  start(envelope: Envelope): Promise<string>;
  events(runId: string): AsyncIterable<NormalizedEvent>;
  result(runId: string): Promise<AdapterResult>;
  cancel(runId: string): Promise<CancelResult>;
  usage(): Promise<AdapterUsage>;
  redactionHits?(runId: string): number;
  processInfo?(runId: string): { pid?: number; pgid?: number };
}
