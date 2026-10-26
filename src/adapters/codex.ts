import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Envelope } from "../core/envelope.ts";
import { buildChildEnv } from "../core/env.ts";
import { Redactor } from "../core/redaction.ts";
import type {
  Adapter,
  AdapterManifest,
  AdapterResult,
  AdapterUsage,
  AuthState,
  CancelResult,
  NormalizedEvent,
  TokenUsage,
} from "./types.ts";

type CodexAdapterOptions = {
  binary?: string;
  model?: string;
  env?: Record<string, string | undefined>;
  redactor?: Redactor;
  logger?: (message: string) => void;
};

class AsyncEventQueue implements AsyncIterable<NormalizedEvent> {
  private values: NormalizedEvent[] = [];
  private waiters: Array<() => void> = [];
  private ended = false;

  push(value: NormalizedEvent): void {
    if (this.ended) return;
    this.values.push(value);
    this.wake();
  }

  close(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<NormalizedEvent> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as NormalizedEvent;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

type RunState = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  queue: AsyncEventQueue;
  text: string[];
  artifacts: string[];
  exit: number | null;
  closed: boolean;
  redactionHits: number;
  usage?: TokenUsage;
  stderr: string;
  terminationReason?: "timeout" | "cancelled";
  timeout?: NodeJS.Timeout;
  forceKill?: NodeJS.Timeout;
  completion: Promise<void>;
  resolveCompletion: () => void;
};

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "message", "output"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return undefined;
}

const TOKEN_USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;

function tokenUsageFromUnknown(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!TOKEN_USAGE_FIELDS.every((field) => typeof record[field] === "number")) return undefined;
  return Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) => [field, record[field]])) as TokenUsage;
}

function actionableStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => !/^\s*ERROR codex_models_manager::cache: failed to load models cache:/.test(line))
    .join("\n")
    .trim();
}

function tomlReadProfile(paths: string[]): string {
  for (const candidate of paths) {
    if (/["\u0000-\u001f\u007f]/.test(candidate)) {
      throw new Error("Codex scope paths must not contain quotes or control characters");
    }
  }
  const entries = ['"."="read"'];
  for (const candidate of paths.slice(1)) {
    entries.push(`${JSON.stringify(candidate)}="read"`);
  }
  return `permissions={ttb_scope={filesystem={":minimal"="read", ":workspace_roots"={${entries.join(", ")}}}}}`;
}

export class CodexAdapter implements Adapter {
  private binary: string;
  private model?: string;
  private additions: Record<string, string | undefined>;
  private redactor: Redactor;
  private logger: (message: string) => void;
  private planEnds?: string;
  private runs = new Map<string, RunState>();

  constructor(options: CodexAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.TTB_CODEX_BIN ?? "codex";
    this.model = options.model;
    this.additions = options.env ?? {};
    this.planEnds = process.env.TTB_CODEX_PLAN_ENDS || undefined;
    this.redactor = options.redactor ?? new Redactor();
    this.logger = options.logger ?? ((message) => process.stderr.write(`[battalion] ${message}\n`));
  }

  manifest(): AdapterManifest {
    return {
      id: "codex",
      ability: "cli",
      capabilities: ["qa", "read", "review"],
      isolation: "custom filesystem permission profile (read-only scope roots)",
      cost_class: "prepaid",
      streaming: "full",
      notes: "Runs ephemeral Codex exec sessions with read access limited to declared workspace roots plus Codex :minimal paths.",
      ...(this.planEnds ? { plan_ends: this.planEnds } : {}),
    };
  }

  async authState(): Promise<AuthState> {
    const output = await new Promise<string>((resolve) => {
      const child = spawn(this.binary, ["login", "status"], {
        env: buildChildEnv(process.env, this.additions),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let captured = "";
      const collect = (chunk: Buffer): void => {
        if (captured.length < 16_384) captured += chunk.toString("utf8").slice(0, 16_384);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(captured));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("");
      }, 5_000);
      timer.unref();
      child.on("close", () => clearTimeout(timer));
    });
    if (/\bLogged in\b/.test(output) && !/\bnot\s+logged in\b/i.test(output)) {
      return { state: "ok", hint: "Codex CLI reports an active login." };
    }
    return { state: "needs_login", hint: "Run codex login interactively, then retry." };
  }

  async start(envelope: Envelope): Promise<string> {
    if (envelope.scope.write !== false || envelope.scope.network !== false) {
      throw new Error("The Milestone 1 Codex adapter accepts read-only, offline scopes only");
    }
    const cwd = envelope.scope.paths[0];
    const args = [
      "exec",
      "-c",
      'default_permissions="ttb_scope"',
      "-c",
      tomlReadProfile(envelope.scope.paths),
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-C",
      cwd,
    ];
    if (this.model) args.push("-m", this.model);
    args.push("-");
    const renderedArgs = args.join(" ");
    if (/dangerously|workspace-write|danger-full-access/.test(renderedArgs) ||
        args.includes("--sandbox") || renderedArgs.includes('="write"')) {
      throw new Error("Unsafe Codex arguments were refused");
    }

    const id = randomUUID();
    const child = spawn(this.binary, args, {
      cwd,
      detached: process.platform !== "win32",
      env: buildChildEnv(process.env, this.additions),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let resolveCompletion = (): void => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const run: RunState = {
      id,
      child,
      queue: new AsyncEventQueue(),
      text: [],
      artifacts: [],
      exit: null,
      closed: false,
      redactionHits: 0,
      stderr: "",
      completion,
      resolveCompletion,
    };
    this.runs.set(id, run);
    this.emit(run, { type: "started", run_id: id });

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(run, line));
    child.stderr.on("data", (chunk: Buffer) => {
      run.stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {
      // EPIPE is represented by the process exit and normalized below.
    });
    child.on("error", (error) => {
      this.emit(run, { type: "error", reason: "spawn_error", message: error.message });
    });
    child.on("close", (code) => {
      if (run.closed) return;
      run.closed = true;
      run.exit = code;
      if (run.timeout) clearTimeout(run.timeout);
      if (run.forceKill) clearTimeout(run.forceKill);
      if (code !== 0 && !run.terminationReason) {
        const message = actionableStderr(run.stderr) || `Codex exited with status ${String(code)}`;
        this.emit(run, { type: "error", reason: "process_exit", message });
      }
      this.emit(run, { type: "finished", exit: code });
      run.queue.close();
      run.resolveCompletion();
    });

    const timeoutMs = Math.max(1, Math.round(envelope.budget.max_time_s * 1_000));
    run.timeout = setTimeout(() => this.terminate(run, "timeout"), timeoutMs);
    run.timeout.unref();
    child.stdin.end(envelope.prompt);
    return id;
  }

  events(runId: string): AsyncIterable<NormalizedEvent> {
    return this.requireRun(runId).queue;
  }

  async result(runId: string): Promise<AdapterResult> {
    const run = this.requireRun(runId);
    await run.completion;
    return {
      text: run.text.join("\n"),
      artifacts: [...run.artifacts],
      exit: run.exit,
      ...(run.usage ? { usage: { ...run.usage } } : {}),
    };
  }

  async cancel(runId: string): Promise<CancelResult> {
    const run = this.requireRun(runId);
    if (!run.closed) this.terminate(run, "cancelled");
    await run.completion;
    return { stopped: !this.groupExists(run.child.pid) };
  }

  async usage(): Promise<AdapterUsage> {
    return { cost_usd: 0, quota: "unknown", ...(this.planEnds ? { plan_ends: this.planEnds } : {}) };
  }

  redactionHits(runId: string): number {
    return this.requireRun(runId).redactionHits;
  }

  processInfo(runId: string): { pid?: number; pgid?: number } {
    const pid = this.requireRun(runId).child.pid;
    return { pid, ...(process.platform !== "win32" ? { pgid: pid } : {}) };
  }

  private requireRun(runId: string): RunState {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    return run;
  }

  private emit(run: RunState, event: NormalizedEvent): void {
    const redacted = this.redactor.redactValue(event);
    run.redactionHits += redacted.hits;
    const safeEvent = redacted.value;
    if (safeEvent.type === "text") run.text.push(safeEvent.text);
    run.queue.push(safeEvent);
  }

  private handleLine(run: RunState, line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (line.trim()) this.emit(run, { type: "text", text: line });
      return;
    }

    const type = String(event.type ?? "unknown");
    if (type === "thread.started" || type === "turn.started" || type === "started") return;
    if (type === "text") {
      const text = textFromUnknown(event);
      if (text) this.emit(run, { type: "text", text });
      return;
    }
    if (type === "error" || type === "turn.failed") {
      this.emit(run, {
        type: "error",
        reason: type === "turn.failed" ? "turn_failed" : String(event.reason ?? "codex_error"),
        message: textFromUnknown(event.error) ?? textFromUnknown(event) ?? "Codex reported an error",
      });
      return;
    }
    if (type === "cost" && typeof event.cost_usd === "number") {
      const usage = tokenUsageFromUnknown(event);
      if (usage) run.usage = usage;
      this.emit(run, { type: "cost", cost_usd: event.cost_usd, ...usage });
      return;
    }
    if (type === "file_changed" && typeof event.path === "string") {
      this.emit(run, { type: "file_changed", path: event.path });
      return;
    }

    if (type === "item.started" || type === "item.completed" || type === "item.updated") {
      const item = event.item && typeof event.item === "object"
        ? event.item as Record<string, unknown>
        : event;
      const itemType = String(item.type ?? "unknown");
      if (itemType === "agent_message") {
        const text = textFromUnknown(item);
        if (text && type !== "item.started") this.emit(run, { type: "text", text });
        return;
      }
      if (["command_execution", "mcp_tool_call", "web_search"].includes(itemType)) {
        const name = String(item.name ?? item.command ?? itemType);
        this.emit(run, {
          type: type === "item.started" ? "tool_call" : "tool_result",
          name,
          detail: item,
        });
        return;
      }
      if (itemType === "file_change") {
        this.emit(run, { type: "file_changed", path: String(item.path ?? "unknown") });
        return;
      }
      const text = textFromUnknown(item);
      if (text) this.emit(run, { type: "text", text });
      return;
    }

    if (type === "turn.completed") {
      const usage = tokenUsageFromUnknown(event.usage);
      if (usage) {
        run.usage = usage;
        this.emit(run, { type: "cost", cost_usd: 0, ...usage });
      }
      return;
    }
    if (type === "finished") return;

    // Unknown records with a clear text payload remain useful; metadata-only
    // records are deliberately ignored. Only the type is logged, never the
    // raw record, so diagnostics cannot become a secret side channel.
    const text = textFromUnknown(event);
    this.logger(`Unknown Codex JSON event type ${JSON.stringify(type)}; ${text ? "mapped to text" : "ignored"}`);
    if (text) this.emit(run, { type: "text", text });
  }

  private terminate(run: RunState, reason: "timeout" | "cancelled"): void {
    if (run.closed || run.terminationReason) return;
    run.terminationReason = reason;
    this.emit(run, {
      type: "error",
      reason,
      message: reason === "timeout" ? "Codex run exceeded its time budget" : "Codex run was cancelled",
    });
    this.signalGroup(run.child, "SIGTERM");
    run.forceKill = setTimeout(() => {
      if (!run.closed) this.signalGroup(run.child, "SIGKILL");
    }, 250);
    run.forceKill.unref();
  }

  private signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
    }
  }

  private groupExists(pid: number | undefined): boolean {
    if (!pid) return false;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
}
