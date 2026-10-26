import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Envelope } from "../core/envelope.ts";
import { buildChildEnv } from "../core/env.ts";
import { resolveTtbHome } from "../core/config.ts";
import { deniedPathKind } from "../core/scope.ts";
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

type CursorAdapterOptions = {
  binary?: string;
  model?: string;
  env?: Record<string, string | undefined>;
  redactor?: Redactor;
  ttbHome?: string;
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
      if (this.values.length) yield this.values.shift() as NormalizedEvent;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

type SnapshotEntry = { digest: string; content?: string; binary: boolean };
type RunState = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  queue: AsyncEventQueue;
  text: string[];
  trace: string[];
  assistantSinceTool: string[];
  sawToolCall: boolean;
  unknownTypes: Set<string>;
  finalText?: string;
  artifacts: string[];
  exit: number | null;
  closed: boolean;
  redactionHits: number;
  stderr: string;
  workspace: string;
  scratch: string;
  snapshot: Map<string, SnapshotEntry>;
  keepScratch: boolean;
  changedFiles?: number;
  usage?: TokenUsage;
  terminationReason?: "timeout" | "cancelled";
  timeout?: NodeJS.Timeout;
  forceKill?: NodeJS.Timeout;
  completion: Promise<void>;
  resolveCompletion: () => void;
};

function shouldSkip(source: string, relative: string): boolean {
  const parts = relative.split(path.sep).filter(Boolean);
  const name = parts.at(-1) ?? "";
  return deniedPathKind(source) !== undefined ||
    parts.some((part) => part === ".git" || part === ".ssh" || part === ".aws" || part.startsWith(".env")) ||
    /(?:^|[._-])(key|keys|credential|credentials|secret|secrets|private[-_]?key)(?:$|[._-])/i.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(name) ||
    /\.(?:pem|key|p12|pfx|keystore|keychain(?:-db)?)$/i.test(name);
}

async function copyTree(source: string, destination: string, relative = ""): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const childSource = path.join(source, entry.name);
    if (shouldSkip(childSource, childRelative) || entry.isSymbolicLink()) continue;
    const childDestination = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(childSource, childDestination, childRelative);
    else if (entry.isFile()) await copyFile(childSource, childDestination);
  }
}

function snapshotEntry(buffer: Buffer): SnapshotEntry {
  const binary = buffer.includes(0);
  return {
    digest: createHash("sha256").update(buffer).digest("hex"),
    ...(binary || buffer.byteLength > 1024 * 1024 ? {} : { content: buffer.toString("utf8") }),
    binary,
  };
}

async function snapshotTree(root: string, current = root, result = new Map<string, SnapshotEntry>()): Promise<Map<string, SnapshotEntry>> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await snapshotTree(root, absolute, result);
    else if (entry.isFile()) result.set(path.relative(root, absolute), snapshotEntry(await readFile(absolute)));
  }
  return result;
}

function diffText(before: Map<string, SnapshotEntry>, after: Map<string, SnapshotEntry>): { text: string; changed: string[] } {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = names.filter((name) => before.get(name)?.digest !== after.get(name)?.digest);
  const lines = ["# ttb Cursor throwaway-workspace diff", ""];
  for (const name of changed) {
    const oldEntry = before.get(name);
    const newEntry = after.get(name);
    lines.push(`--- ${oldEntry ? `a/${name}` : "/dev/null"}`);
    lines.push(`+++ ${newEntry ? `b/${name}` : "/dev/null"}`);
    if (oldEntry?.binary || newEntry?.binary || oldEntry?.content === undefined && oldEntry || newEntry?.content === undefined && newEntry) {
      lines.push("Binary or oversized file changed", "");
      continue;
    }
    lines.push("@@");
    if (oldEntry?.content !== undefined) {
      for (const line of oldEntry.content.split("\n")) lines.push(`-${line}`);
    }
    if (newEntry?.content !== undefined) {
      for (const line of newEntry.content.split("\n")) lines.push(`+${line}`);
    }
    lines.push("");
  }
  if (!changed.length) lines.push("No files changed.", "");
  return { text: lines.join("\n"), changed };
}

function messageText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) return typeof record.text === "string" ? [record.text] : [];
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const part = item as Record<string, unknown>;
    return part.type === "text" && typeof part.text === "string" ? [part.text] : [];
  });
}

function usageFrom(value: unknown): TokenUsage | undefined {
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
  };
}

export class CursorAdapter implements Adapter {
  private binary: string;
  private model?: string;
  private additions: Record<string, string | undefined>;
  private redactor: Redactor;
  private ttbHome: string;
  private logger: (message: string) => void;
  private runs = new Map<string, RunState>();

  constructor(options: CursorAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.TTB_CURSOR_BIN ?? "cursor-agent";
    this.model = options.model;
    this.additions = options.env ?? {};
    this.redactor = options.redactor ?? new Redactor();
    this.ttbHome = path.resolve(options.ttbHome ?? resolveTtbHome());
    this.logger = options.logger ?? ((message) => process.stderr.write(`[battalion] ${message}\n`));
  }

  manifest(): AdapterManifest {
    return {
      id: "cursor",
      ability: "cli",
      capabilities: ["qa", "read", "review", "patch", "run"],
      isolation: "throwaway copy plus Cursor sandbox enabled",
      cost_class: "prepaid",
      streaming: "full",
      notes: "Always runs against a disposable copy; changes return only as a redacted diff artifact and require approval.",
    };
  }

  async authState(): Promise<AuthState> {
    const output = await this.capture(["status"]);
    if (/unable to fetch user details|Authentication required/i.test(output)) {
      return { state: "needs_login", hint: "cursor-agent login" };
    }
    return { state: "ok", hint: "Cursor CLI status did not report an authentication error." };
  }

  async start(envelope: Envelope): Promise<string> {
    if (!envelope.approval_id) throw new Error("Cursor tasks require approval");
    if (envelope.scope.network !== false) throw new Error("Cursor network access is disabled in P1");
    const id = randomUUID();
    const scratch = path.join(this.ttbHome, "scratch", id);
    const workspace = path.join(scratch, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    for (const [index, source] of envelope.scope.paths.entries()) {
      const destination = index === 0
        ? workspace
        : path.join(workspace, "additional", `${index}-${path.basename(source)}`);
      await copyTree(source, destination);
    }
    const snapshot = await snapshotTree(workspace);
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--sandbox", "enabled",
      "--trust",
      "--workspace", workspace,
    ];
    if (envelope.read_only !== false) args.push("--mode", "ask");
    if (this.model) args.push("--model", this.model);
    this.assertSafeArgs(args, workspace);

    const child = spawn(this.binary, args, {
      cwd: workspace,
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
      trace: [],
      assistantSinceTool: [],
      sawToolCall: false,
      unknownTypes: new Set(),
      artifacts: [],
      exit: null,
      closed: false,
      redactionHits: 0,
      stderr: "",
      workspace,
      scratch,
      snapshot,
      keepScratch: envelope.keep_scratch === true,
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
    child.on("close", (code) => { void this.finalize(run, code); });
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
      artifacts: [...run.artifacts],
      exit: run.exit,
      ...(run.usage ? { usage: { ...run.usage } } : {}),
      ...(run.changedFiles !== undefined ? { changed_files: run.changedFiles } : {}),
    };
  }

  async cancel(runId: string): Promise<CancelResult> {
    const run = this.requireRun(runId);
    if (!run.closed) this.terminate(run, "cancelled");
    await run.completion;
    return { stopped: !this.groupExists(run.child.pid) };
  }

  async usage(): Promise<AdapterUsage> { return { cost_usd: 0, quota: "unknown" }; }
  redactionHits(runId: string): number { return this.requireRun(runId).redactionHits; }
  processInfo(runId: string): { pid?: number; pgid?: number } {
    const pid = this.requireRun(runId).child.pid;
    return { pid, ...(process.platform !== "win32" ? { pgid: pid } : {}) };
  }

  private async finalize(run: RunState, code: number | null): Promise<void> {
    if (run.closed) return;
    run.closed = true;
    run.exit = code;
    if (run.timeout) clearTimeout(run.timeout);
    if (run.forceKill) clearTimeout(run.forceKill);
    try {
      const after = await snapshotTree(run.workspace);
      const diff = diffText(run.snapshot, after);
      run.changedFiles = diff.changed.length;
      for (const changed of diff.changed) this.emit(run, { type: "file_changed", path: changed });
      const safeDiff = this.redactor.redact(diff.text);
      run.redactionHits += safeDiff.hits;
      const artifact = path.join(this.ttbHome, "artifacts", `${run.id}.diff`);
      await mkdir(path.dirname(artifact), { recursive: true, mode: 0o700 });
      await writeFile(artifact, safeDiff.text, { mode: 0o600 });
      run.artifacts.push(artifact);
    } catch (error) {
      this.emit(run, { type: "error", reason: "diff_error", message: (error as Error).message });
    } finally {
      if (!run.keepScratch) await rm(run.scratch, { recursive: true, force: true });
    }
    if (code !== 0 && !run.terminationReason) {
      this.emit(run, { type: "error", reason: "process_exit", message: run.stderr.trim() || `Cursor exited with status ${String(code)}` });
    }
    this.emit(run, { type: "finished", exit: code });
    run.queue.close();
    run.resolveCompletion();
  }

  private handleLine(run: RunState, line: string): void {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { if (line.trim()) this.emit(run, { type: "text", text: line }); return; }
    const type = String(event.type ?? "unknown");
    if (type === "system" && event.subtype === "init") return;
    if (type === "assistant" || type === "user") {
      for (const text of messageText(event.message)) {
        this.emit(run, { type: "text", text });
        if (type === "assistant" && run.sawToolCall) run.assistantSinceTool.push(text);
      }
      return;
    }
    if (type === "tool_call") {
      run.sawToolCall = true;
      run.assistantSinceTool = [];
      this.emit(run, {
        type: event.subtype === "completed" ? "tool_result" : "tool_call",
        name: String(event.tool_name ?? event.name ?? "cursor_tool"),
        detail: event,
      });
      return;
    }
    if (type === "result") {
      if (typeof event.result === "string") {
        const candidate = run.sawToolCall && run.assistantSinceTool.join("\n").trim()
          ? run.assistantSinceTool.join("\n")
          : event.result;
        const safeResult = this.redactor.redact(candidate);
        run.redactionHits += safeResult.hits;
        run.finalText = safeResult.text;
        if (!run.text.length) this.emit(run, { type: "text", text: safeResult.text });
      }
      const usage = usageFrom(event.usage);
      if (usage) {
        run.usage = usage;
        this.emit(run, { type: "cost", cost_usd: 0, ...usage });
      }
      if (event.is_error === true) this.emit(run, { type: "error", reason: "cursor_result", message: String(event.result ?? event.subtype ?? "Cursor reported an error") });
      return;
    }
    if (type === "thinking") {
      for (const text of messageText(event.text ?? event.message)) run.trace.push(text);
      return;
    }
    const texts = messageText(event.message ?? event);
    if (!run.unknownTypes.has(type)) {
      run.unknownTypes.add(type);
      this.logger(`Unknown Cursor JSON event type ${JSON.stringify(type)}; ${texts.length ? "mapped to text" : "ignored"}`);
    }
    for (const text of texts) this.emit(run, { type: "text", text });
  }

  private emit(run: RunState, event: NormalizedEvent): void {
    const safe = this.redactor.redactValue(event);
    run.redactionHits += safe.hits;
    if (safe.value.type === "text") run.text.push(safe.value.text);
    run.queue.push(safe.value);
  }

  private assertSafeArgs(args: string[], workspace: string): void {
    const forbidden = new Set(["--force", "-f", "--yolo", "--approve-mcps", "--auto-review", "--worktree", "-w"]);
    if (args.some((arg) => forbidden.has(arg))) throw new Error("Unsafe Cursor arguments were refused");
    const sandboxIndex = args.indexOf("--sandbox");
    if (sandboxIndex < 0 || args[sandboxIndex + 1] !== "enabled") throw new Error("Cursor sandbox must be enabled");
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--workspace" && args[index + 1] !== workspace) throw new Error("Cursor workspace escaped its scratch copy");
      if (args[index] === "--add-dir" && !(args[index + 1] === workspace || args[index + 1]?.startsWith(`${workspace}${path.sep}`))) {
        throw new Error("Cursor add-dir escaped its scratch copy");
      }
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
    this.emit(run, { type: "error", reason, message: reason === "timeout" ? "Cursor run exceeded its time budget" : "Cursor run was cancelled" });
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

  private groupExists(pid: number | undefined): boolean {
    if (!pid) return false;
    try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
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
