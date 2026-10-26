export const TASK_KINDS = ["qa", "read", "review", "patch", "run"] as const;
export const TASK_MODES = ["explicit", "picked", "fanout"] as const;

export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskMode = (typeof TASK_MODES)[number];

export type TaskScope = {
  paths: string[];
  write: false | "throwaway";
  network: false;
  machine: "macbook";
};

export type TaskBudget = {
  max_time_s: number;
  max_cost_usd: 0;
};

export type Envelope = {
  task_id: string;
  parent_task_id?: string;
  thread_id: string;
  from: string;
  to: string;
  kind: TaskKind;
  prompt: string;
  scope: TaskScope;
  budget: TaskBudget;
  mode: TaskMode;
  hops: number;
  lead: string;
  read_only?: boolean;
  keep_scratch?: boolean;
  approval_id?: string;
};

export class EnvelopeValidationError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(`Invalid envelope: ${issues.join("; ")}`);
    this.name = "EnvelopeValidationError";
    this.issues = issues;
  }
}

const ENVELOPE_FIELDS = new Set([
  "task_id",
  "parent_task_id",
  "thread_id",
  "from",
  "to",
  "kind",
  "prompt",
  "scope",
  "budget",
  "mode",
  "hops",
  "lead",
  "read_only",
  "keep_scratch",
  "approval_id",
]);
const SCOPE_FIELDS = new Set(["paths", "write", "network", "machine"]);
const BUDGET_FIELDS = new Set(["max_time_s", "max_cost_usd"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: Set<string>,
  location: string,
  issues: string[],
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) issues.push(`${location} has unknown field ${field}`);
  }
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  issues: string[],
): void {
  if (typeof value[field] !== "string" || value[field].length === 0) {
    issues.push(`${field} must be a non-empty string`);
  }
}

export function validateEnvelope(input: unknown): Envelope {
  const issues: string[] = [];
  if (!isRecord(input)) {
    throw new EnvelopeValidationError(["envelope must be an object"]);
  }

  rejectUnknown(input, ENVELOPE_FIELDS, "envelope", issues);
  for (const field of ["task_id", "thread_id", "from", "to", "prompt", "lead"]) {
    requireString(input, field, issues);
  }
  if (input.parent_task_id !== undefined &&
      (typeof input.parent_task_id !== "string" || input.parent_task_id.length === 0)) {
    issues.push("parent_task_id must be a non-empty string when present");
  }
  if (!TASK_KINDS.includes(input.kind as TaskKind)) issues.push("kind is invalid");
  if (!TASK_MODES.includes(input.mode as TaskMode)) issues.push("mode is invalid");
  if (!Number.isInteger(input.hops) || (input.hops as number) < 0 || (input.hops as number) > 2) {
    issues.push("hops must be an integer from 0 through 2");
  }
  if (input.read_only !== undefined && typeof input.read_only !== "boolean") {
    issues.push("read_only must be a boolean when present");
  }
  if (input.keep_scratch !== undefined && typeof input.keep_scratch !== "boolean") {
    issues.push("keep_scratch must be a boolean when present");
  }
  if (input.approval_id !== undefined &&
      (typeof input.approval_id !== "string" || input.approval_id.length === 0)) {
    issues.push("approval_id must be a non-empty string when present");
  }

  if (!isRecord(input.scope)) {
    issues.push("scope must be an object");
  } else {
    rejectUnknown(input.scope, SCOPE_FIELDS, "scope", issues);
    if (!Array.isArray(input.scope.paths) || input.scope.paths.length === 0 ||
        input.scope.paths.some((path) => typeof path !== "string" || path.length === 0)) {
      issues.push("scope.paths must be a non-empty array of strings");
    }
    if (input.scope.write !== false && input.scope.write !== "throwaway") {
      issues.push('scope.write must be false or "throwaway"');
    }
    if (input.scope.network !== false) issues.push("scope.network must be false in P1");
    if (input.scope.machine !== "macbook") issues.push('scope.machine must be "macbook"');
  }

  if (!isRecord(input.budget)) {
    issues.push("budget must be an object");
  } else {
    rejectUnknown(input.budget, BUDGET_FIELDS, "budget", issues);
    if (typeof input.budget.max_time_s !== "number" ||
        !Number.isFinite(input.budget.max_time_s) || input.budget.max_time_s <= 0) {
      issues.push("budget.max_time_s must be a positive finite number");
    }
    if (input.budget.max_cost_usd !== 0) {
      issues.push("budget.max_cost_usd must be 0");
    }
  }

  if (issues.length > 0) throw new EnvelopeValidationError(issues);
  return { ...input, read_only: input.read_only ?? true } as Envelope;
}
