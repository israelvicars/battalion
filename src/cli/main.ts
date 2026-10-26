import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AuditLog, verifyAudit } from "../core/audit.ts";
import { ApprovalStore } from "../core/approvals.ts";
import { Broker } from "../core/broker.ts";
import { resolveTtbHome } from "../core/config.ts";
import type { Envelope } from "../core/envelope.ts";
import { assertSafeSlug } from "../core/ids.ts";
import { LeadLockError } from "../core/lock.ts";
import { Redactor, sha256 } from "../core/redaction.ts";
import { RunStore } from "../core/runs.ts";
import { ThreadStore } from "../core/threads.ts";
import { CodexAdapter } from "../adapters/codex.ts";
import { CursorAdapter } from "../adapters/cursor.ts";
import { ClaudeAdapter } from "../adapters/claude.ts";
import { MuseVaultDropAdapter } from "../adapters/muse-vaultdrop.ts";
import type { Adapter } from "../adapters/types.ts";
import { adapterEnvAdditions } from "../core/policy.ts";

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  WORKER: 5,
  AUDIT_INVALID: 6,
} as const;

class CliError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

type Parsed = {
  positional: string[];
  json: boolean;
  from: string;
  scope?: string;
  thread?: string;
  all: boolean;
  keepScratch: boolean;
  host: string;
  port: number;
  agree?: string;
  disagree?: string;
  changedDecision?: "yes" | "no" | "unknown";
};

const COMMAND_USAGE = "Commands: agents, profile, send, fanout, compare, tally, threads, thread, approvals, approve, deny, audit verify, kill, poll, serve, ui";

type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export type Hub = {
  home: string;
  audit: AuditLog;
  broker: Broker;
  muse: MuseVaultDropAdapter;
  adapters: Adapter[];
  threads: ThreadStore;
  approvals: ApprovalStore;
  runs: RunStore;
  redactor: Redactor;
};

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {
    positional: [],
    json: false,
    from: "grok",
    all: false,
    keepScratch: false,
    host: "127.0.0.1",
    port: 7717,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--all") parsed.all = true;
    else if (arg === "--keep-scratch") parsed.keepScratch = true;
    else if (["--from", "--scope", "--thread", "--host", "--port", "--agree", "--disagree", "--changed-decision"].includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || (value.startsWith("--") && arg !== "--agree" && arg !== "--disagree")) {
        throw new CliError(`${arg} requires a value`, EXIT.USAGE);
      }
      index += 1;
      if (arg === "--from") parsed.from = value;
      if (arg === "--scope") parsed.scope = value;
      if (arg === "--thread") parsed.thread = value;
      if (arg === "--host") parsed.host = value;
      if (arg === "--port") {
        if (!/^(?:0|[1-9][0-9]{0,4})$/.test(value)) {
          throw new CliError("--port must be an integer from 0 to 65535", EXIT.USAGE);
        }
        parsed.port = Number(value);
        if (parsed.port > 65_535) throw new CliError("--port must be an integer from 0 to 65535", EXIT.USAGE);
      }
      if (arg === "--agree") parsed.agree = value;
      if (arg === "--disagree") parsed.disagree = value;
      if (arg === "--changed-decision") {
        if (value !== "yes" && value !== "no") throw new CliError("--changed-decision must be yes or no", EXIT.USAGE);
        parsed.changedDecision = value;
      }
    } else if (arg.startsWith("--")) {
      throw new CliError(`Unknown option: ${arg}`, EXIT.USAGE);
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function agentId(input: string): string {
  if (!input.startsWith("@")) throw new CliError(`Agent must use @name syntax: ${input}`, EXIT.USAGE);
  const id = input.slice(1);
  if (id === "muse") return "muse-vaultdrop";
  return id;
}

function displayAgent(id: string): string {
  return id === "muse-vaultdrop" ? "muse" : id;
}

function makeId(prefix: "task" | "thread"): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function envelopeFor(
  target: string,
  prompt: string,
  options: Parsed,
  mode: "explicit" | "fanout" = "explicit",
  taskId = makeId("task"),
  threadId = options.thread ?? makeId("thread"),
): Envelope {
  assertSafeSlug(options.from, "from");
  assertSafeSlug(taskId, "task_id");
  assertSafeSlug(threadId, "thread_id");
  if (options.scope !== undefined && !path.isAbsolute(options.scope)) {
    throw new CliError("--scope must be absolute", EXIT.USAGE);
  }
  const scope = path.resolve(options.scope ?? process.cwd());
  return {
    task_id: taskId,
    thread_id: threadId,
    from: options.from,
    to: target,
    kind: "qa",
    prompt,
    scope: { paths: [scope], write: false, network: false, machine: "macbook" },
    budget: { max_time_s: 300, max_cost_usd: 0 },
    mode,
    hops: 0,
    lead: options.from,
    read_only: true,
    ...(options.keepScratch ? { keep_scratch: true } : {}),
  };
}

export async function createHub(): Promise<Hub> {
  const home = resolveTtbHome();
  const redactor = new Redactor();
  const audit = new AuditLog(home);
  const threads = new ThreadStore(home, redactor);
  const runs = new RunStore(home);
  const codex = new CodexAdapter({ redactor });
  const cursor = new CursorAdapter({
    redactor,
    ttbHome: home,
    env: await adapterEnvAdditions(home, "cursor"),
  });
  const claude = new ClaudeAdapter({ redactor });
  const muse = new MuseVaultDropAdapter();
  const adapters: Adapter[] = [codex, cursor, claude, muse];
  const approvals = new ApprovalStore(home, audit, redactor);
  const broker = new Broker({
    adapters,
    audit,
    redactor,
    threads,
    runs,
    approvalCheck: (id, envelope) => approvals.isApproved(id, envelope),
  });
  return {
    home,
    audit,
    broker,
    muse,
    adapters,
    threads,
    approvals,
    runs,
    redactor,
  };
}

async function readJsonOptional(filename: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listThreads(store: ThreadStore): Promise<Array<{ id: string; messages: number; last_ts?: string }>> {
  let names: string[];
  try {
    names = await readdir(store.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -6);
    const lines = (await readFile(path.join(store.directory, name), "utf8")).split("\n").filter(Boolean);
    const last = lines.length ? JSON.parse(lines.at(-1) as string) as { ts?: string } : undefined;
    result.push({ id, messages: lines.length, ...(last?.ts ? { last_ts: last.ts } : {}) });
  }
  return result;
}

export async function readThread(store: ThreadStore, id: string): Promise<unknown[]> {
  assertSafeSlug(id, "thread id");
  try {
    return (await readFile(store.pathFor(id), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`Thread not found: ${id}`, EXIT.NOT_FOUND);
    }
    throw error;
  }
}

function processExists(pid: number, group: boolean): boolean {
  try {
    process.kill(group && process.platform !== "win32" ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function killRun(
  record: Awaited<ReturnType<RunStore["list"]>>[number],
  runs: RunStore,
  audit?: AuditLog,
): Promise<{ run_id: string; stopped: boolean; reason?: string; stale?: boolean }> {
  const group = record.pgid !== null && process.platform !== "win32";
  const target = group ? record.pgid as number : record.pid;
  if (target === process.pid) {
    const result = { run_id: record.run_id, stopped: false, reason: "refused_current_process" };
    if (audit) await auditRunKill(audit, record, result);
    return result;
  }
  await runs.markKilled(record.run_id);
  if (!processExists(target, group)) {
    await runs.remove(record.run_id);
    await runs.clearKilled(record.run_id);
    const result = { run_id: record.run_id, stopped: true, stale: true };
    if (audit) await auditRunKill(audit, record, result);
    return result;
  }
  try {
    process.kill(group ? -target : target, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 750;
  while (Date.now() < deadline && processExists(target, group)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processExists(target, group)) {
    try {
      process.kill(group ? -target : target, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const killDeadline = Date.now() + 500;
    while (Date.now() < killDeadline && processExists(target, group)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const stopped = !processExists(target, group);
  if (stopped) await runs.remove(record.run_id);
  const result = { run_id: record.run_id, stopped };
  if (audit) await auditRunKill(audit, record, result);
  return result;
}

async function auditRunKill(
  audit: AuditLog,
  record: Awaited<ReturnType<RunStore["list"]>>[number],
  result: { stopped: boolean; stale?: boolean },
): Promise<void> {
  await audit.append({
    event: result.stopped ? "run.killed" : "run.kill_failed",
    task_id: record.task_id,
    thread_id: record.thread_id,
    agent: record.agent,
    scope: { paths: [], write: false, network: false, machine: "macbook" },
    redaction_hits: 0,
    prompt_sha256: sha256(""),
    prompt_preview: "",
    result_sha256: sha256(JSON.stringify(result)),
    exit: null,
    ok: result.stopped,
    error_reason: result.stopped ? null : "process_still_running",
    usage: null,
  });
}

export async function resolveApproval(
  hub: Hub,
  id: string,
  action: "approve" | "deny",
): Promise<{ data: unknown; exitCode: number }> {
  const pending = await hub.approvals.read(id);
  if (action === "approve" && pending.agent === "muse") {
    return { data: await hub.muse.approve(id), exitCode: EXIT.OK };
  }
  if (action === "deny" && pending.agent === "muse") {
    return { data: await hub.muse.deny(id), exitCode: EXIT.OK };
  }
  if (action === "approve" && pending.agent !== "cursor") {
    throw new CliError(`Unsupported approval agent: ${pending.agent}`, EXIT.USAGE);
  }
  const claim = await hub.approvals.claim(id);
  try {
    if (action === "deny") {
      const denied = await hub.approvals.finish(claim, "denied");
      await hub.threads.append({
        task_id: denied.envelope.task_id,
        thread_id: denied.envelope.thread_id,
        from: denied.envelope.to,
        to: denied.envelope.from,
        kind: "outbound_reply",
        text: "DENIED: " + id,
        untrusted: true,
      });
      return { data: denied, exitCode: EXIT.OK };
    }
    const approval = await hub.approvals.finish(claim, "approved");
    const envelope = { ...approval.envelope, approval_id: approval.id };
    try {
      const result = await hub.broker.dispatch(envelope);
      await hub.threads.append({
        task_id: envelope.task_id,
        thread_id: envelope.thread_id,
        from: envelope.to,
        to: envelope.from,
        kind: "outbound_reply",
        text: result.ok || result.text ? result.text : `ERROR: ${result.error?.message ?? "worker failed"}`,
        untrusted: true,
      });
      return { data: { approval, result }, exitCode: result.ok ? EXIT.OK : EXIT.WORKER };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await hub.threads.append({
        task_id: envelope.task_id,
        thread_id: envelope.thread_id,
        from: envelope.to,
        to: envelope.from,
        kind: "outbound_reply",
        text: "ERROR: " + message,
        untrusted: true,
      });
      throw error;
    }
  } catch (error) {
    await hub.approvals.release(claim);
    throw error;
  }
}

function human(command: string, data: unknown): string {
  if (command === "send" && data && typeof data === "object" && "result" in data) {
    return `${String((data as { result: { text?: string } }).result.text ?? "")}\n`;
  }
  if (command === "send" && data && typeof data === "object" && "approval" in data) {
    return `${JSON.stringify((data as { approval: unknown }).approval, null, 2)}\n`;
  }
  if (command === "fanout" && data && typeof data === "object" && "skeleton" in data) {
    return `${String((data as { skeleton: string }).skeleton)}\n`;
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

async function execute(
  parsed: Parsed,
  onUiStarted?: (data: { url: string; host: string; port: number }) => void,
): Promise<{ command: string; data: unknown; exitCode?: number; silent?: boolean }> {
  const [command, ...args] = parsed.positional;
  if (!command) throw new CliError(`Usage: battalion <command> [arguments]\n${COMMAND_USAGE}`, EXIT.USAGE);

  if (command === "ui") {
    if (args.length) throw new CliError("Usage: battalion ui [--port N] [--host 127.0.0.1]", EXIT.USAGE);
    const { startUiServer } = await import("../web/server.ts");
    const ui = await startUiServer({ host: parsed.host, port: parsed.port });
    onUiStarted?.({ url: ui.url, host: ui.host, port: ui.port });
    let resolveShutdown = (): void => {};
    const shutdown = new Promise<void>((resolve) => { resolveShutdown = resolve; });
    const stop = (): void => resolveShutdown();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await shutdown;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await ui.close();
    }
    return { command, data: { stopped: true }, silent: true };
  }
  const hub = await createHub();

  const submit = async (envelope: Envelope): Promise<{ result?: unknown; approval?: unknown }> => {
    if (envelope.to === "cursor") {
      const approval = await hub.approvals.createForAgent("cursor", envelope);
      return { approval };
    }
    return { result: await hub.broker.dispatch(envelope) };
  };

  if (command === "agents") {
    if (args.length) throw new CliError("Usage: battalion agents", EXIT.USAGE);
    const data = await Promise.all(hub.adapters.map(async (adapter) => ({
      ...adapter.manifest(),
      id: displayAgent(adapter.manifest().id),
      auth: await adapter.authState(),
      usage: await adapter.usage(),
    })));
    return { command, data };
  }

  if (command === "profile") {
    if (args.length !== 1) throw new CliError("Usage: battalion profile <agent>", EXIT.USAGE);
    const internal = args[0].replace(/^@/, "") === "muse" ? "muse-vaultdrop" : args[0].replace(/^@/, "");
    const adapter = hub.adapters.find((item) => item.manifest().id === internal);
    if (!adapter) throw new CliError(`Unknown agent: ${args[0]}`, EXIT.NOT_FOUND);
    const persisted = await readJsonOptional(path.join(hub.home, "profiles", `${internal}.json`)) as
      { user?: unknown; learned?: unknown } | undefined;
    return {
      command,
      data: {
        agent: displayAgent(internal),
        system: adapter.manifest(),
        user: persisted?.user ?? {},
        learned: persisted?.learned ?? [],
      },
    };
  }

  if (command === "send") {
    if (args.length !== 2) throw new CliError('Usage: battalion send @<agent> "<prompt>"', EXIT.USAGE);
    const target = agentId(args[0]);
    const envelope = envelopeFor(target, args[1], parsed);
    let outcome;
    try {
      outcome = await submit(envelope);
    } finally {
      if (target === "muse-vaultdrop") await hub.muse.stop();
    }
    if (outcome.approval) {
      return { command, data: { task_id: envelope.task_id, thread_id: envelope.thread_id, approval: outcome.approval } };
    }
    const result = outcome.result as { ok: boolean };
    return { command, data: { task_id: envelope.task_id, thread_id: envelope.thread_id, result }, exitCode: result.ok ? 0 : EXIT.WORKER };
  }

  if (command === "fanout") {
    if (args.length !== 3) throw new CliError('Usage: battalion fanout @a @b "<prompt>"', EXIT.USAGE);
    const targets = [agentId(args[0]), agentId(args[1])];
    const threadId = parsed.thread ?? makeId("thread");
    const envelopes = targets.map((target) => envelopeFor(target, args[2], parsed, "fanout", makeId("task"), threadId));
    const settled = await Promise.allSettled(envelopes.map((envelope) => submit(envelope)));
    if (targets.includes("muse-vaultdrop")) await hub.muse.stop();
    const answers = settled.map((item, index) => item.status === "fulfilled"
      ? { agent: displayAgent(targets[index]), ...item.value }
      : { agent: displayAgent(targets[index]), error: (item.reason as Error).message });
    const skeleton = [
      `# Fanout comparison (${threadId})`,
      "",
      ...answers.flatMap((answer) => [
        `## @${answer.agent}`,
        "result" in answer
          ? String((answer.result as { text?: string }).text ?? "")
          : "approval" in answer
            ? `PENDING APPROVAL: ${String((answer.approval as { id?: string }).id ?? "unknown")}`
            : `ERROR: ${answer.error}`,
        "",
      ]),
      "## Agree",
      `_Pending: record with battalion compare ${threadId} ..._`,
      "",
      "## Disagree",
      `_Pending: record with battalion compare ${threadId} ..._`,
    ].join("\n");
    await Promise.all(answers.map((answer, index) => {
      const text = "result" in answer
        ? String((answer.result as { text?: string }).text ?? "")
        : "approval" in answer
          ? `PENDING APPROVAL: ${String((answer.approval as { id?: string }).id ?? "unknown")}`
          : `ERROR: ${answer.error}`;
      return hub.threads.append({
        task_id: envelopes[index].task_id,
        thread_id: threadId,
        from: targets[index],
        to: parsed.from,
        kind: "outbound_reply",
        text,
        untrusted: true,
      }, "approval" in answer ? { hubGeneratedApprovalId: (answer.approval as { id?: string }).id } : undefined);
    }));
    const failed = settled.some((item) => item.status === "rejected" ||
      (item.status === "fulfilled" && item.value.result !== undefined &&
        !(item.value.result as { ok?: boolean }).ok));
    return { command, data: { thread_id: threadId, answers, comparison: { agree: null, disagree: null }, skeleton }, exitCode: failed ? EXIT.WORKER : 0 };
  }

  if (command === "threads") {
    if (args.length) throw new CliError("Usage: battalion threads", EXIT.USAGE);
    return { command, data: await listThreads(hub.threads) };
  }

  if (command === "thread") {
    if (args.length !== 1) throw new CliError("Usage: battalion thread <id>", EXIT.USAGE);
    return { command, data: { id: args[0], messages: await readThread(hub.threads, args[0]) } };
  }

  if (command === "compare") {
    if (args.length !== 1 || parsed.agree === undefined || parsed.disagree === undefined) {
      throw new CliError('Usage: battalion compare <thread_id> --agree "<text>" --disagree "<text>" [--changed-decision yes|no] [--from <caller>]', EXIT.USAGE);
    }
    const threadId = args[0];
    await readThread(hub.threads, threadId);
    const changedDecision = parsed.changedDecision ?? "unknown";
    const agree = hub.redactor.redact(parsed.agree);
    const disagree = hub.redactor.redact(parsed.disagree);
    const disagreement = disagree.text.trim().toLowerCase() !== "none" && disagree.text.trim() !== "";
    const taskId = makeId("task");
    const text = `agree: ${agree.text}\ndisagree: ${disagree.text}`;
    await hub.threads.append({
      task_id: taskId,
      thread_id: threadId,
      from: parsed.from,
      to: parsed.from,
      kind: "comparison",
      text,
      agree: agree.text,
      disagree: disagree.text,
      changed_decision: changedDecision,
      untrusted: false,
    });
    await hub.audit.append({
      event: "comparison.recorded",
      task_id: threadId,
      thread_id: threadId,
      agent: parsed.from,
      scope: { paths: [], write: false, network: false, machine: "macbook" },
      redaction_hits: agree.hits + disagree.hits,
      prompt_sha256: sha256(`comparison:${agree.text}:${disagree.text}`),
      prompt_preview: `comparison disagree=${disagreement ? 1 : 0} changed=${changedDecision}`,
      result_sha256: sha256(JSON.stringify({ agree: agree.text, disagree: disagree.text, changed_decision: changedDecision })),
      exit: 0,
      ok: true,
      error_reason: null,
      usage: null,
    });
    return {
      command,
      data: { thread_id: threadId, agree: agree.text, disagree: disagree.text, changed_decision: changedDecision, disagreement },
    };
  }

  if (command === "tally") {
    if (args.length) throw new CliError("Usage: battalion tally", EXIT.USAGE);
    let comparisons = 0;
    let withDisagreement = 0;
    let changedDecisionYes = 0;
    let changedDecisionNo = 0;
    let unknown = 0;
    try {
      const lines = (await readFile(hub.audit.path, "utf8")).split("\n").filter(Boolean);
      for (const line of lines) {
        const record = JSON.parse(line) as { event?: string; prompt_preview?: string };
        if (record.event !== "comparison.recorded") continue;
        comparisons += 1;
        const preview = record.prompt_preview ?? "";
        if (/\bdisagree=1\b/.test(preview)) withDisagreement += 1;
        if (/\bchanged=yes\b/.test(preview)) changedDecisionYes += 1;
        else if (/\bchanged=no\b/.test(preview)) changedDecisionNo += 1;
        else unknown += 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { command, data: { comparisons, with_disagreement: withDisagreement, changed_decision_yes: changedDecisionYes, changed_decision_no: changedDecisionNo, unknown } };
  }

  if (command === "approvals") {
    if (args.length) throw new CliError("Usage: battalion approvals", EXIT.USAGE);
    return { command, data: await hub.approvals.list("pending") };
  }

  if (command === "approve") {
    if (args.length !== 1) throw new CliError("Usage: battalion approve <id>", EXIT.USAGE);
    const resolved = await resolveApproval(hub, args[0], "approve");
    return { command, ...resolved };
  }

  if (command === "deny") {
    if (args.length !== 1) throw new CliError("Usage: battalion deny <id>", EXIT.USAGE);
    const resolved = await resolveApproval(hub, args[0], "deny");
    return { command, ...resolved };
  }

  if (command === "audit") {
    if (args.length !== 1 || args[0] !== "verify") throw new CliError("Usage: battalion audit verify", EXIT.USAGE);
    const verification = await verifyAudit(hub.audit.path);
    return { command: "audit verify", data: verification, exitCode: verification.valid ? 0 : EXIT.AUDIT_INVALID };
  }

  if (command === "kill") {
    if ((parsed.all && args.length) || (!parsed.all && args.length !== 1)) {
      throw new CliError("Usage: battalion kill [--all|<run>]", EXIT.USAGE);
    }
    const records = await hub.runs.list();
    const selected = parsed.all ? records : records.filter((record) => record.run_id === args[0]);
    if (!parsed.all && selected.length === 0) throw new CliError(`Run not found: ${args[0]}`, EXIT.NOT_FOUND);
    const results = [];
    for (const record of selected) results.push(await killRun(record, hub.runs, hub.audit));
    return { command, data: results, exitCode: results.every((item) => (item as { stopped: boolean }).stopped) ? 0 : EXIT.CONFLICT };
  }

  if (command === "poll") {
    if (args.length) throw new CliError("Usage: battalion poll", EXIT.USAGE);
    return { command, data: await hub.muse.pollOnce() };
  }

  if (command === "serve") {
    if (args.length) throw new CliError("Usage: battalion serve", EXIT.USAGE);
    let resolveShutdown = (): void => {};
    const shutdown = new Promise<void>((resolve) => { resolveShutdown = resolve; });
    const stop = (): void => resolveShutdown();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await hub.muse.startPolling();
      await shutdown;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await hub.muse.stop();
    }
    return { command, data: { stopped: true } };
  }

  throw new CliError(`Unknown command: ${command}`, EXIT.USAGE);
}

export async function runCli(
  args = process.argv.slice(2),
  io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    const value = error as Error & { exitCode?: number };
    const exitCode = value.exitCode ?? EXIT.INTERNAL;
    if (args.includes("--json")) {
      io.stdout(`${JSON.stringify({ ok: false, command: null, error: { message: value.message, code: exitCode } })}\n`);
    } else {
      io.stderr(`${value.message}\n`);
    }
    return exitCode;
  }
  try {
    let started = false;
    const result = await execute(parsed, (data) => {
      started = true;
      if (parsed.json) io.stdout(`${JSON.stringify({ ok: true, command: "ui", data })}\n`);
      else io.stdout(`${data.url}\n`);
    });
    const exitCode = result.exitCode ?? EXIT.OK;
    if (!result.silent) {
      if (parsed.json) io.stdout(`${JSON.stringify({ ok: exitCode === 0, command: result.command, data: result.data })}\n`);
      else io.stdout(human(result.command, result.data));
    } else if (!started) {
      throw new Error("UI stopped before startup completed");
    }
    return exitCode;
  } catch (error) {
    const value = error as Error & { exitCode?: number; code?: string };
    let exitCode = value.exitCode ?? EXIT.INTERNAL;
    if (value instanceof LeadLockError || /already being resolved|already (?:approved|denied)/.test(value.message)) {
      exitCode = EXIT.CONFLICT;
    } else if (value.code === "ENOENT") {
      exitCode = EXIT.NOT_FOUND;
    }
    const payload = { ok: false, command: parsed.positional[0] ?? null, error: { message: value.message, code: exitCode } };
    if (parsed.json) io.stdout(`${JSON.stringify(payload)}\n`);
    else io.stderr(`${value.message}\n`);
    return exitCode;
  }
}
