import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { AuditLog } from "../src/core/audit.ts";
import { Broker } from "../src/core/broker.ts";
import type { Envelope } from "../src/core/envelope.ts";
import { LeadLockError } from "../src/core/lock.ts";
import { RunStore } from "../src/core/runs.ts";
import { ThreadStore } from "../src/core/threads.ts";

const cli = path.resolve("bin/ttb");
const codexFixture = path.resolve("test/fixtures/mock-codex.mjs");
const hangFixture = path.resolve("test/fixtures/mock-codex-hang.mjs");

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ttb-m3-"));
  await mkdir(path.join(root, "Projects"), { recursive: true });
  await mkdir(path.join(root, "Agents", "vault"), { recursive: true });
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  return root;
}

function cliEnv(root: string, additions: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TTB_HOME: path.join(root, "ttb-home"),
    TTB_MUSE_MAILBOX: path.join(root, "mailbox"),
    TTB_CODEX_BIN: codexFixture,
    TTB_SCOPE_ROOTS: path.join(root, "Projects"),
    HOME: root,
    ...additions,
  };
}

function startCli(root: string, args: string[], additions: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: path.resolve("."),
    env: cliEnv(root, additions),
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const completed = new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  return { child, completed };
}

async function runCli(root: string, args: string[], additions: NodeJS.ProcessEnv = {}) {
  return startCli(root, args, additions).completed;
}

async function jsonCli(root: string, args: string[], additions: NodeJS.ProcessEnv = {}) {
  const result = await runCli(root, [...args, "--json"], additions);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`CLI did not return JSON. stdout=${result.stdout} stderr=${result.stderr}`);
  }
  return { ...result, json };
}

async function waitFor(predicate: () => Promise<boolean>, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function exists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function envelope(workspace: string, overrides: Partial<Envelope> = {}): Envelope {
  const base: Envelope = {
    task_id: "m3-task",
    thread_id: "m3-thread",
    from: "grok",
    to: "codex",
    kind: "qa",
    prompt: "Reply with OK",
    scope: { paths: [workspace], write: false, network: false, machine: "macbook" },
    budget: { max_time_s: 5, max_cost_usd: 0 },
    mode: "explicit",
    hops: 0,
    lead: "grok",
  };
  return {
    ...base,
    ...overrides,
    scope: { ...base.scope, ...overrides.scope },
    budget: { ...base.budget, ...overrides.budget },
  };
}

test("M3.1 all dispatches lock, peer scope defaults narrow, and Codex profile includes extra roots", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "Projects", "allowed", "workspace");
  const extra = path.join(root, "Projects", "allowed", "extra");
  const outside = path.join(root, "outside");
  const home = path.join(root, "ttb-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(extra, { recursive: true });
  await mkdir(outside);
  await mkdir(home);
  await writeFile(path.join(home, "policy.json"), JSON.stringify({ scope_roots: [path.join(root, "Projects", "allowed")] }));

  const argsFile = path.join(root, "captured-args.json");
  const capture = new CodexAdapter({
    binary: codexFixture,
    env: { MOCK_CODEX_MODE: "capture", MOCK_ARGS_FILE: argsFile },
  });
  const peerOptions = { peerEnv: {}, peerUserHome: root };
  const captureBroker = new Broker({ adapters: [capture], audit: new AuditLog(home), ...peerOptions });
  const captured = await captureBroker.dispatch(envelope(workspace, {
    task_id: "profile-task",
    scope: { paths: [workspace, extra], write: false, network: false, machine: "macbook" },
  }));
  assert(captured.ok);
  const args = (JSON.parse(await readFile(argsFile, "utf8")) as { args: string[] }).args;
  const profile = args[args.indexOf('default_permissions="ttb_scope"') + 2];
  assert.match(profile, /"\."="read"/);
  const expectedExtra = `${JSON.stringify(await realpath(extra))}="read"`;
  assert(profile.includes(expectedExtra), `${profile} did not contain ${expectedExtra}`);
  assert(!args.includes("--sandbox"));
  assert(!args.join(" ").match(/dangerously|workspace-write|danger-full-access/));

  await captureBroker.dispatch(envelope(workspace, {
    task_id: "peer-allowed",
    from: "muse",
    lead: "muse",
    hops: 1,
  }));
  await assert.rejects(
    captureBroker.dispatch(envelope(outside, {
      task_id: "peer-outside",
      from: "muse",
      lead: "muse",
      hops: 1,
    })),
    /peer-originated task restrictions/,
  );

  const lockHome = path.join(root, "lock-home");
  const hanging = new CodexAdapter({ binary: hangFixture });
  const firstBroker = new Broker({ adapters: [hanging], audit: new AuditLog(lockHome) });
  const pending = firstBroker.dispatch(envelope(workspace, { task_id: "all-spokes-lock" }));
  const runs = new RunStore(lockHome);
  await waitFor(async () => (await runs.list()).length === 1, "hanging run record");
  const secondBroker = new Broker({
    adapters: [new CodexAdapter({ binary: codexFixture })],
    audit: new AuditLog(lockHome),
  });
  await assert.rejects(
    secondBroker.dispatch(envelope(workspace, { task_id: "all-spokes-lock", lead: "muse" })),
    (error: unknown) => error instanceof LeadLockError && error.locked_by === "grok",
  );
  const [run] = await runs.list();
  await hanging.cancel(run.run_id);
  await pending;
  assert.deepEqual(await runs.list(), []);
});

test("M3.2 CLI agents, profile, send, fanout, threads, thread, and audit verify return stable JSON", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "Projects", "workspace");
  await mkdir(workspace);

  const agents = await jsonCli(root, ["agents"]);
  assert.equal(agents.code, 0);
  assert.deepEqual((agents.json.data as Array<{ id: string }>).map((item) => item.id), ["codex", "cursor", "claude", "muse"]);

  const profile = await jsonCli(root, ["profile", "codex"]);
  assert.equal(profile.code, 0);
  assert.equal((profile.json.data as { agent: string }).agent, "codex");

  const sent = await jsonCli(root, [
    "send", "@codex", "Reply with OK", "--scope", workspace, "--thread", "cli-thread", "--from", "grok",
  ]);
  assert.equal(sent.code, 0);
  assert.equal((((sent.json.data as { result: { text: string } }).result).text), "OK");

  const fanout = await jsonCli(root, ["fanout", "@codex", "@codex", "Compare", "--scope", workspace]);
  assert.equal(fanout.code, 0);
  assert.match((fanout.json.data as { skeleton: string }).skeleton, /## Agree/);
  assert.equal((fanout.json.data as { answers: unknown[] }).answers.length, 2);

  const threadStore = new ThreadStore(path.join(root, "ttb-home"));
  await threadStore.append({
    task_id: "seed-task",
    thread_id: "seed-thread",
    from: "grok",
    to: "muse",
    kind: "outbound_task",
    text: "seed",
    untrusted: false,
  });
  const threads = await jsonCli(root, ["threads"]);
  assert((threads.json.data as Array<{ id: string }>).some((item) => item.id === "seed-thread"));
  const thread = await jsonCli(root, ["thread", "seed-thread"]);
  assert.equal((thread.json.data as { messages: unknown[] }).messages.length, 1);

  const verified = await jsonCli(root, ["audit", "verify"]);
  assert.equal(verified.code, 0);
  assert.equal((verified.json.data as { valid: boolean }).valid, true);
  const usage = await jsonCli(root, ["send", "codex", "bad", "--scope", workspace]);
  assert.equal(usage.code, 2);
  assert.equal((usage.json.error as { code: number }).code, 2);
});

function museTask(taskId: string, threadId: string, workspace: string, prompt: string): string {
  return [
    "---",
    `task_id: ${taskId}`,
    `thread_id: ${threadId}`,
    "from: muse",
    "to: codex",
    "kind: qa",
    "hops: 0",
    "lead: muse",
    `scope_path: ${workspace}`,
    "max_time_s: 5",
    "max_cost_usd: 0",
    "mode: explicit",
    "---",
    prompt,
  ].join("\n");
}

test("M3.3 poll persists cursor, defaults Muse tasks to approval, and approve/deny resolve them", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "Projects", "workspace");
  const inbox = path.join(root, "mailbox", "inbox");
  const home = path.join(root, "ttb-home");
  await mkdir(workspace);
  await mkdir(inbox, { recursive: true });
  const fakeToken = `ghp_${"APPROVALFIXTURE".repeat(3)}`;
  const firstContent = museTask("approval-one", "approval-thread", workspace, `Review ${fakeToken}`);
  await writeFile(path.join(inbox, "task-approval-one.md"), firstContent);
  await writeFile(path.join(inbox, "task-approval-two.md"), museTask("approval-two", "approval-thread", workspace, "Second"));

  const polled = await jsonCli(root, ["poll"]);
  assert.equal(polled.code, 0);
  assert.deepEqual(polled.json.data, { processed: 2, rejected: 0, pending_approvals: 2 });
  assert(await exists(path.join(home, "state", "muse-cursor.json")));
  const approvalText = await readFile(path.join(home, "approvals", "muse-approval-one.json"), "utf8");
  assert.match(approvalText, /\[REDACTED:github-token\]/);
  assert(!approvalText.includes(fakeToken));

  const archived = (await readdir(path.join(inbox, "processed")))
    .find((name) => name.startsWith("task-approval-one.md.")) as string;
  await copyFile(path.join(inbox, "processed", archived), path.join(inbox, "task-approval-one.md"));
  const restarted = await jsonCli(root, ["poll"]);
  assert.deepEqual(restarted.json.data, { processed: 1, rejected: 0, pending_approvals: 0 });
  const auditBefore = (await readFile(path.join(home, "audit", "audit.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string });
  assert.equal(auditBefore.filter((item) => item.event === "approval.requested").length, 2);

  const approvals = await jsonCli(root, ["approvals"]);
  assert.equal((approvals.json.data as unknown[]).length, 2);
  const approved = await jsonCli(root, ["approve", "muse-approval-one"]);
  assert.equal(approved.code, 0);
  assert(await exists(path.join(root, "mailbox", "outbox", "reply-approval-one.md")));
  const denied = await jsonCli(root, ["deny", "muse-approval-two"]);
  assert.equal(denied.code, 0);
  assert.match(await readFile(path.join(root, "mailbox", "outbox", "reply-approval-two.md"), "utf8"), /status: denied/);
  const remaining = await jsonCli(root, ["approvals"]);
  assert.deepEqual(remaining.json.data, []);
});

test("M3.4 send to Muse completes a temp-mailbox round trip and records the thread", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "Projects", "workspace");
  const mailbox = path.join(root, "mailbox");
  await mkdir(workspace);
  const running = startCli(root, [
    "send", "@muse", "Peer question", "--scope", workspace, "--thread", "muse-cli-thread", "--json",
  ]);
  t.after(() => {
    if (running.child.exitCode === null) running.child.kill("SIGKILL");
  });
  const outbound = path.join(mailbox, "outbox", "task-");
  let taskId = "";
  await waitFor(async () => {
    try {
      const name = (await readdir(path.join(mailbox, "outbox"))).find((item) => /^task-.*\.md$/.test(item));
      if (!name) return false;
      taskId = name.slice(5, -3);
      return true;
    } catch {
      return false;
    }
  }, outbound);
  await writeFile(path.join(mailbox, "inbox", `reply-${taskId}.md`), [
    "---",
    `task_id: ${taskId}`,
    "thread_id: muse-cli-thread",
    "from: muse",
    "---",
    "Muse says OK",
  ].join("\n"));
  const completed = await running.completed;
  assert.equal(completed.code, 0, completed.stderr);
  const output = JSON.parse(completed.stdout) as { data: { result: { text: string } } };
  assert.equal(output.data.result.text, "Muse says OK");
  const thread = await jsonCli(root, ["thread", "muse-cli-thread"]);
  assert.equal((thread.json.data as { messages: unknown[] }).messages.length, 2);
});

test("M3.5 kill --all terminates cross-process run groups and removes run records", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "Projects", "workspace");
  const runsDirectory = path.join(root, "ttb-home", "runs");
  await mkdir(workspace);
  const running = startCli(root, ["send", "@codex", "Hang", "--scope", workspace, "--json"], {
    TTB_CODEX_BIN: hangFixture,
  });
  t.after(() => {
    if (running.child.exitCode === null) running.child.kill("SIGKILL");
  });
  let record: { run_id: string; pgid: number } | undefined;
  await waitFor(async () => {
    try {
      const name = (await readdir(runsDirectory)).find((item) => item.endsWith(".json"));
      if (!name) return false;
      record = JSON.parse(await readFile(path.join(runsDirectory, name), "utf8"));
      return true;
    } catch {
      return false;
    }
  }, "live run record");
  const killed = await jsonCli(root, ["kill", "--all"]);
  assert.equal(killed.code, 0, killed.stderr);
  const sender = await running.completed;
  assert.equal(sender.code, 5);
  assert.deepEqual(await new RunStore(path.join(root, "ttb-home")).list(), []);
  assert.throws(
    () => process.kill(-(record as { pgid: number }).pgid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
  );

  const runStore = new RunStore(path.join(root, "ttb-home"));
  await runStore.add({
    run_id: "stale-run",
    pid: 999_999,
    pgid: null,
    agent: "codex",
    task_id: "stale-task",
    thread_id: "stale-thread",
  });
  const stale = await jsonCli(root, ["kill", "stale-run"]);
  assert.equal(stale.code, 0);
  assert.deepEqual(await runStore.list(), []);
});

test("M3.6 serve shuts down cleanly on SIGTERM", async (t) => {
  const root = await temporaryRoot(t);
  const running = startCli(root, ["serve", "--json"]);
  t.after(() => {
    if (running.child.exitCode === null) running.child.kill("SIGKILL");
  });
  await waitFor(
    () => exists(path.join(root, "mailbox", "inbox")),
    "serve mailbox initialization",
  );
  running.child.kill("SIGTERM");
  const completed = await running.completed;
  assert.equal(completed.code, 0, completed.stderr);
  assert.deepEqual(JSON.parse(completed.stdout), { ok: true, command: "serve", data: { stopped: true } });
});
