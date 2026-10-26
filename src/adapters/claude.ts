import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Envelope } from "../core/envelope.ts";
import { buildChildEnv } from "../core/env.ts";
import { Redactor } from "../core/redaction.ts";
import { groupHasLiveMember } from "./process-group.ts";
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

type ClaudeAdapterOptions = {
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
  push(value: NormalizedEvent): void { if (!this.ended) { this.values.push(value); this.wake(); } }
  close(): void { this.ended = true; this.wake(); }
  private wake(): void { for (const waiter of this.waiters.splice(0)) waiter(); }
  async *[Symbol.asyncIterator](): AsyncIterator<NormalizedEvent> {
    while (true) {
      if (this.values.length) yield this.values.shift() as NormalizedEvent;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

type RunState = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  queue: AsyncEventQueue;
  text: string[];
  finalText?: string;
  exit: number | null;
  closed: boolean;
  redactionHits: number;
  stderr: string;
  usage?: TokenUsage;
  terminationReason?: "timeout" | "cancelled" | "metered_auth_refused";
  timeout?: NodeJS.Timeout;
  forceKill?: NodeJS.Timeout;
  completion: Promise<void>;
  resolveCompletion: () => void;
};

function usageFrom(value: unknown, totalCost?: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const numeric = (name: string): number => typeof record[name] === "number" ? record[name] as number : 0;
  if (!["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
    .some((name) => typeof record[name] === "number")) return undefined;
  return {
    input_tokens: numeric("input_tokens"),
    cached_input_tokens: numeric("cache_read_input_tokens"),
    cache_write_input_tokens: numeric("cache_creation_input_tokens"),
    output_tokens: numeric("output_tokens"),
    reasoning_output_tokens: 0,
    ...(typeof totalCost === "number" ? { total_cost_usd: totalCost } : {}),
  };
}

function messageContent(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const content = (value as Record<string, unknown>).content;
  return Array.isArray(content)
    ? content.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

export class ClaudeAdapter implements Adapter {
  private binary: string;
  private model?: string;
  private additions: Record<string, string | undefined>;
  private redactor: Redactor;
  private logger: (message: string) => void;
  private runs = new Map<string, RunState>();
  private observedCostUsd = 0;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.TTB_CLAUDE_BIN ?? "claude";
    this.model = options.model;
    this.additions = options.env ?? {};
    for (const name of Object.keys(this.additions)) {
      if (/^ANTHROPIC_/i.test(name) || name === "CLAUDE_CODE_USE_BEDROCK" || name === "CLAUDE_CODE_USE_VERTEX") {
        throw new Error(`Claude metered-auth environment variable is forbidden: ${name}`);
      }
    }
    this.redactor = options.redactor ?? new Redactor();
    this.logger = options.logger ?? ((message) => process.stderr.write(`[battalion] ${message}\n`));
  }

  manifest(): AdapterManifest {
    return {
      id: "claude",
      ability: "cli",
      capabilities: ["qa", "read", "review"],
      isolation: "--restricted with Read,Grep,Glob only and scoped working directories",
      cost_class: "subscription-only; metered key auth refused",
      streaming: "full",
      notes: "Uses the verified restricted Claude Code profile; any non-none apiKeySource aborts the run.",
    };
  }

  async authState(): Promise<AuthState> {
    const output = await this.capture(["auth", "status"]);
    try {
      const parsed = JSON.parse(output) as { loggedIn?: unknown; authMethod?: unknown };
      if (parsed.loggedIn === true) return { state: "ok", hint: `Claude CLI is logged in (${String(parsed.authMethod ?? "unknown method")}).` };
    } catch {
      // Non-JSON or malformed status fails closed to needs_login.
    }
    return { state: "needs_login", hint: "claude auth login" };
  }

  async start(envelope: Envelope): Promise<string> {
    if (envelope.read_only === false || envelope.scope.write !== false || envelope.scope.network !== false) {
      throw new Error("The Milestone 4 Claude adapter accepts read-only, offline tasks only");
    }
    const cwd = envelope.scope.paths[0];
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--restricted",
      "--strict-mcp-config",
      "--tools", "Read,Grep,Glob",
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--no-session-persistence",
    ];
    for (const extra of envelope.scope.paths.slice(1)) args.push("--add-dir", extra);
    if (this.model) args.push("--model", this.model);
    this.assertSafeArgs(args);

    const id = randomUUID();
    const child = spawn(this.binary, args, {
      cwd,
      detached: process.platform !== "win32",
      env: buildChildEnv(process.env, this.additions),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let resolveCompletion = (): void => {};
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const run: RunState = {
      id,
      child,
      queue: new AsyncEventQueue(),
      text: [],
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
    child.stderr.on("data", (chunk: Buffer) => { run.stderr += chunk.toString("utf8"); });
    child.stdin.on("error", () => {});
    child.on("error", (error) => this.emit(run, { type: "error", reason: "spawn_error", message: error.message }));
    child.on("close", (code) => this.finalize(run, code));
    const timeoutMs = Math.max(1, Math.round(envelope.budget.max_time_s * 1_000));
    run.timeout = setTimeout(() => this.terminate(run, "timeout"), timeoutMs);
    run.timeout.unref();
    child.stdin.end(envelope.prompt);
    return id;
  }

  events(runId: string): AsyncIterable<NormalizedEvent> { return this.requireRun(runId).queue; }
  async result(runId: string): Promise<AdapterResult> {
    const run = this.requireRun(runId);
    await run.completion;
    return {
      text: run.finalText ?? run.text.join("\n"),
      artifacts: [],
      exit: run.exit,
      ...(run.usage ? { usage: { ...run.usage } } : {}),
    };
  }
  async cancel(runId: string): Promise<CancelResult> {
    const run = this.requireRun(runId);
    if (!run.closed) this.terminate(run, "cancelled");
    await run.completion;
    return { stopped: !(await groupHasLiveMember(run.child.pid)) };
  }
  async usage(): Promise<AdapterUsage> { return { cost_usd: this.observedCostUsd, quota: "unknown" }; }
  redactionHits(runId: string): number { return this.requireRun(runId).redactionHits; }
  processInfo(runId: string): { pid?: number; pgid?: number } {
    const pid = this.requireRun(runId).child.pid;
    return { pid, ...(process.platform !== "win32" ? { pgid: pid } : {}) };
  }

  private handleLine(run: RunState, line: string): void {
    if (run.terminationReason === "metered_auth_refused") return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { if (line.trim()) this.emit(run, { type: "text", text: line }); return; }
    const type = String(event.type ?? "unknown");
    if (type === "system" && event.subtype === "init") {
      if (event.apiKeySource !== "none") this.refuseMeteredAuth(run);
      return;
    }
    if (type === "system" && event.subtype === "permission_denied") {
      this.emit(run, {
        type: "error",
        reason: "permission_denied",
        message: `${String(event.tool_name ?? "tool")}: ${String(event.message ?? event.decision_reason_type ?? "permission denied")}`,
      });
      return;
    }
    if (type === "assistant") {
      for (const part of messageContent(event.message)) {
        if (part.type === "text" && typeof part.text === "string") this.emit(run, { type: "text", text: part.text });
        if (part.type === "tool_use") this.emit(run, { type: "tool_call", name: String(part.name ?? "claude_tool"), detail: part });
      }
      const usage = usageFrom((event.message as Record<string, unknown> | undefined)?.usage);
      if (usage) run.usage = usage;
      return;
    }
    if (type === "user") {
      for (const part of messageContent(event.message)) {
        if (part.type === "tool_result") this.emit(run, { type: "tool_result", name: String(part.tool_use_id ?? "claude_tool"), detail: part });
      }
      return;
    }
    if (type === "result") {
      if (typeof event.result === "string") {
        const safeResult = this.redactor.redact(event.result);
        run.redactionHits += safeResult.hits;
        run.finalText = safeResult.text;
      }
      const usage = usageFrom(event.usage, event.total_cost_usd);
      if (usage) {
        run.usage = usage;
        this.observedCostUsd += usage.total_cost_usd ?? 0;
        this.emit(run, { type: "cost", cost_usd: usage.total_cost_usd ?? 0, ...usage });
      }
      if (event.is_error === true) this.emit(run, { type: "error", reason: "claude_result", message: String(event.result ?? event.subtype ?? "Claude reported an error") });
      return;
    }
    this.logger(`Unknown Claude JSON event type ${JSON.stringify(type)}; ignored`);
  }

  private refuseMeteredAuth(run: RunState): void {
    if (run.closed || run.terminationReason) return;
    run.terminationReason = "metered_auth_refused";
    this.emit(run, {
      type: "error",
      reason: "metered_auth_refused",
      message: "Claude reported metered key authentication; zero-spend policy refused the run",
    });
    this.signalGroup(run.child, "SIGTERM");
    run.forceKill = setTimeout(() => { if (!run.closed) this.signalGroup(run.child, "SIGKILL"); }, 250);
    run.forceKill.unref();
  }

  private finalize(run: RunState, code: number | null): void {
    if (run.closed) return;
    run.closed = true;
    run.exit = code;
    if (run.timeout) clearTimeout(run.timeout);
    if (run.forceKill) clearTimeout(run.forceKill);
    if (code !== 0 && !run.terminationReason) {
      this.emit(run, { type: "error", reason: "process_exit", message: run.stderr.trim() || `Claude exited with status ${String(code)}` });
    }
    this.emit(run, { type: "finished", exit: code });
    run.queue.close();
    run.resolveCompletion();
  }

  private emit(run: RunState, event: NormalizedEvent): void {
    const safe = this.redactor.redactValue(event);
    run.redactionHits += safe.hits;
    if (safe.value.type === "text") run.text.push(safe.value.text);
    run.queue.push(safe.value);
  }

  private assertSafeArgs(args: string[]): void {
    const forbidden = new Set([
      "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
      "bypassPermissions", "acceptEdits", "auto", "--settings", "--mcp-config",
      "--plugin-dir", "--cloud", "--bg", "--background", "--remote-control",
      "--resume", "--continue",
    ]);
    if (args.some((arg) => forbidden.has(arg))) throw new Error("Unsafe Claude arguments were refused");
    const tools = args[args.indexOf("--tools") + 1];
    if (tools !== "Read,Grep,Glob") throw new Error("Claude tools must remain read-only");
    if (!args.includes("--restricted") || !args.includes("--strict-mcp-config")) {
      throw new Error("Claude restricted mode is required");
    }
  }

  private requireRun(runId: string): RunState {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    return run;
  }

  private terminate(run: RunState, reason: "timeout" | "cancelled"): void {
    if (run.closed || run.terminationReason) return;
    run.terminationReason = reason;
    this.emit(run, { type: "error", reason, message: reason === "timeout" ? "Claude run exceeded its time budget" : "Claude run was cancelled" });
    this.signalGroup(run.child, "SIGTERM");
    run.forceKill = setTimeout(() => { if (!run.closed) this.signalGroup(run.child, "SIGKILL"); }, 250);
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
  private capture(args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, args, { env: buildChildEnv(process.env, this.additions), stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const collect = (chunk: Buffer): void => { if (output.length < 16_384) output += chunk.toString("utf8").slice(0, 16_384); };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(output));
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(""); }, 5_000);
      timer.unref();
      child.on("close", () => clearTimeout(timer));
    });
  }
}
