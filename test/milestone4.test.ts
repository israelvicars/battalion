import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeAdapter } from "../src/adapters/claude.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { CursorAdapter } from "../src/adapters/cursor.ts";
import { groupHasLiveMember } from "../src/adapters/process-group.ts";
import type { Adapter, NormalizedEvent } from "../src/adapters/types.ts";
import { ApprovalStore } from "../src/core/approvals.ts";
import { AuditLog, verifyAudit } from "../src/core/audit.ts";
import { Broker } from "../src/core/broker.ts";
import type { Envelope } from "../src/core/envelope.ts";
import { peerScopeRoots } from "../src/core/policy.ts";

const cli = path.resolve("bin/ttb");
const codexFixture = path.resolve("test/fixtures/mock-codex.mjs");
const cursorFixture = path.resolve("test/fixtures/mock-cursor.mjs");
const claudeFixture = path.resolve("test/fixtures/mock-claude.mjs");

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ttb-m4-"));
  await mkdir(path.join(root, "Projects"), { recursive: true });
  await mkdir(path.join(root, "Agents", "vault"), { recursive: true });
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  return root;
}

function envelope(workspace: string, to: string, overrides: Partial<Envelope> = {}): Envelope {
  const base: Envelope = {
    task_id: `m4-${to}-task`,
    thread_id: `m4-${to}-thread`,
    from: "grok",
    to,
    kind: "qa",
    prompt: "Reply with OK",
    scope: { paths: [workspace], write: false, network: false, machine: "macbook" },
    budget: { max_time_s: 5, max_cost_usd: 0 },
    mode: "explicit",
    hops: 0,
    lead: "grok",
    read_only: true,
  };
  return {
    ...base,
    ...overrides,
    scope: { ...base.scope, ...overrides.scope },
    budget: { ...base.budget, ...overrides.budget },
  };
}

async function approveCursor(store: ApprovalStore, input: Envelope): Promise<Envelope> {
  const pending = await store.createForAgent("cursor", input);
  const claim = await store.claim(pending.id);
  const approved = await store.finish(claim, "approved");
  return { ...approved.envelope, approval_id: approved.id };
}

async function collect(adapter: Adapter, runId: string): Promise<NormalizedEvent[]> {
  const result: NormalizedEvent[] = [];
  for await (const event of adapter.events(runId)) result.push(event);
  return result;
}

async function waitForFile(filename: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await stat(filename); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

async function assertGroupGone(pid: number): Promise<void> {
  // The hang fixture spawns a grandchild that ignores SIGTERM, so the group
  // only disappears once the OS reaps it; allow a generous window.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await groupHasLiveMember(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process group ${pid} still has a live member`);
}

test("M4.1 configured peer roots and TTB_VAULT can narrow but never widen, with audited failure", async (t) => {
  const root = await temporaryRoot(t);
  const projects = path.join(root, "Projects");
  const narrow = path.join(projects, "narrow");
  const outside = path.join(root, "outside");
  const home = path.join(root, "ttb-home");
  await mkdir(narrow);
  await mkdir(outside);
  assert.deepEqual(await peerScopeRoots(home, { TTB_SCOPE_ROOTS: narrow }, root), [await realpath(narrow)]);
  await assert.rejects(peerScopeRoots(home, { TTB_SCOPE_ROOTS: outside }, root), /may only narrow/);
  await assert.rejects(peerScopeRoots(home, { TTB_VAULT: outside }, root), /TTB_VAULT may only narrow/);

  const escape = path.join(projects, "escape-link");
  await symlink(outside, escape);
  await assert.rejects(peerScopeRoots(home, { TTB_SCOPE_ROOTS: escape }, root), /may only narrow/);

  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "policy.json"), JSON.stringify({ scope_roots: [outside] }));
  await assert.rejects(peerScopeRoots(home, {}, root), /may only narrow/);

  const workspace = path.join(projects, "workspace");
  await mkdir(workspace);
  const audit = new AuditLog(home);
  const broker = new Broker({
    adapters: [new CodexAdapter({ binary: codexFixture })],
    audit,
    peerEnv: {},
    peerUserHome: root,
  });
  await assert.rejects(broker.dispatch(envelope(workspace, "codex", {
    task_id: "widened-policy",
    from: "muse",
    lead: "muse",
    hops: 1,
  })), /may only narrow/);
  const records = (await readFile(audit.path, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as { event: string; error_reason: string });
  assert(records.some((record) => record.event === "scope.config_rejected" &&
    record.error_reason === "scope_configuration_rejected"));
  assert.deepEqual(await verifyAudit(audit.path), { valid: true, records: records.length });
});

test("M4.2 Cursor runs only in a copy, redacts its diff, and removes scratch", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "Projects", "cursor-workspace");
  const home = path.join(root, "ttb-home");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "original.txt"), "unchanged\n");
  await writeFile(path.join(workspace, ".env.local"), "MUST_NOT_COPY=fixture\n");
  const audit = new AuditLog(home);
  const approvals = new ApprovalStore(home, audit);
  const adapter = new CursorAdapter({ binary: cursorFixture, ttbHome: home });
  const broker = new Broker({
    adapters: [adapter],
    audit,
    approvalCheck: (id, item) => approvals.isApproved(id, item),
  });
  const approved = await approveCursor(approvals, envelope(workspace, "cursor"));
  await assert.rejects(broker.dispatch({ ...approved, prompt: "changed after approval" }), /resolved approval/);
  const result = await broker.dispatch(approved);
  assert.equal(result.ok, true);
  assert.equal(result.changed_files, 1);
  assert.equal(result.artifacts?.length, 1);
  await assert.rejects(readFile(path.join(workspace, "cursor-created.txt")), /ENOENT/);
  assert.equal(await readFile(path.join(workspace, "original.txt"), "utf8"), "unchanged\n");
  const artifact = await readFile(result.artifacts?.[0] as string, "utf8");
  assert.match(artifact, /cursor-created\.txt/);
  assert.match(artifact, /\[REDACTED:github-token\]/);
  assert(!artifact.includes("ghp_"));
  const scratchRoot = path.join(home, "scratch");
  assert.deepEqual(await readdir(scratchRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  }), []);
  const allHomeText = await Promise.all([
    readFile(audit.path, "utf8"),
    readFile(result.artifacts?.[0] as string, "utf8"),
    readFile(path.join(home, "approvals", `${approved.approval_id}.json`), "utf8"),
  ]);
  assert(!allHomeText.join("\n").includes("ghp_"));
});

test("M4.3 Cursor argv, stdin, deny-skipping, keep-scratch, auth, and env are constrained", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "Projects", "capture");
  const home = path.join(root, "ttb-home");
  await mkdir(path.join(workspace, ".ssh"), { recursive: true });
  await writeFile(path.join(workspace, ".ssh", "id_fixture"), "not copied");
  await writeFile(path.join(workspace, "visible.txt"), "visible");
  const prior = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "cursor-fixture-secret-value";
  t.after(() => {
    if (prior === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prior;
  });
  const audit = new AuditLog(home);
  const approvals = new ApprovalStore(home, audit);
  const adapter = new CursorAdapter({ binary: cursorFixture, ttbHome: home });
  assert.equal((await adapter.authState()).state, "ok");
  assert.deepEqual(await new CursorAdapter({
    binary: cursorFixture,
    ttbHome: home,
    env: { MOCK_CURSOR_STATUS: "Authentication required" },
  }).authState(), { state: "needs_login", hint: "cursor-agent login" });
  const broker = new Broker({ adapters: [adapter], audit, approvalCheck: (id, item) => approvals.isApproved(id, item) });
  const approved = await approveCursor(approvals, envelope(workspace, "cursor", {
    task_id: "cursor-capture",
    prompt: "CAPTURE",
    keep_scratch: true,
  }));
  const result = await broker.dispatch(approved);
  const capture = JSON.parse(result.text) as { args: string[]; stdin: string; env: Record<string, string>; cwd: string };
  assert.equal(capture.stdin, "CAPTURE");
  assert(!capture.args.includes("CAPTURE"));
  assert.deepEqual(capture.args.slice(0, 7), ["-p", "--output-format", "stream-json", "--sandbox", "enabled", "--trust", "--workspace"]);
  assert.equal(await realpath(capture.args[7]), capture.cwd);
  assert.deepEqual(capture.args.slice(-2), ["--mode", "ask"]);
  for (const forbidden of ["--force", "-f", "--yolo", "--approve-mcps", "--auto-review", "--worktree", "-w"]) {
    assert(!capture.args.includes(forbidden), `unsafe argument ${forbidden}`);
  }
  assert(!capture.args.join(" ").includes("--sandbox disabled"));
  assert(!capture.args.includes(workspace));
  assert.equal(capture.env.CURSOR_API_KEY, undefined);
  const [scratchId] = await readdir(path.join(home, "scratch"));
  const copied = path.join(home, "scratch", scratchId, "workspace");
  assert.equal(await readFile(path.join(copied, "visible.txt"), "utf8"), "visible");
  await assert.rejects(readFile(path.join(copied, ".ssh", "id_fixture")), /ENOENT/);
});

test("M4.4 Claude argv is restricted, prompt uses stdin, env blocks all metered auth, and usage is audited", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "Projects", "claude-workspace");
  const extra = path.join(root, "Projects", "claude-extra");
  const home = path.join(root, "ttb-home");
  await mkdir(workspace);
  await mkdir(extra);
  const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = `${name.toLowerCase()}-fixture-value`;
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  const audit = new AuditLog(home);
  const adapter = new ClaudeAdapter({ binary: claudeFixture });
  assert.equal((await adapter.authState()).state, "ok");
  assert.deepEqual(await new ClaudeAdapter({
    binary: claudeFixture,
    env: { MOCK_CLAUDE_LOGGED_OUT: "1" },
  }).authState(), { state: "needs_login", hint: "claude auth login" });
  assert.throws(() => new ClaudeAdapter({
    binary: claudeFixture,
    env: { ANTHROPIC_API_KEY: "explicit-fixture-value" },
  }), /metered-auth environment variable is forbidden/);
  const broker = new Broker({ adapters: [adapter], audit });
  const result = await broker.dispatch(envelope(workspace, "claude", {
    prompt: "CAPTURE",
    scope: { paths: [workspace, extra], write: false, network: false, machine: "macbook" },
  }));
  const capture = JSON.parse(result.text) as { args: string[]; stdin: string; env: Record<string, string>; cwd: string };
  assert.equal(capture.stdin, "CAPTURE");
  assert.equal(capture.cwd, await realpath(workspace));
  for (const required of ["-p", "--output-format", "stream-json", "--verbose", "--restricted", "--strict-mcp-config", "--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--no-session-persistence"]) {
    assert(capture.args.includes(required), `missing ${required}`);
  }
  assert.deepEqual(capture.args.slice(capture.args.indexOf("--add-dir"), capture.args.indexOf("--add-dir") + 2), ["--add-dir", await realpath(extra)]);
  assert(!capture.args.includes("CAPTURE"));
  for (const forbidden of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "acceptEdits", "auto", "--settings", "--mcp-config", "--plugin-dir", "--cloud", "--bg", "--background", "--remote-control", "--resume", "--continue"]) {
    assert(!capture.args.includes(forbidden), `unsafe argument ${forbidden}`);
  }
  for (const name of names) assert.equal(capture.env[name], undefined, `${name} leaked`);
  assert.equal(result.usage?.total_cost_usd, 0);
  const dispatch = (await readFile(audit.path, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.event === "dispatch.completed") as { usage: { total_cost_usd: number } };
  assert.equal(dispatch.usage.total_cost_usd, 0);
});

test("M4.5 Claude refuses metered auth and exposes permission denial", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "Projects", "claude-guard");
  const home = path.join(root, "ttb-home");
  await mkdir(workspace);
  const events: NormalizedEvent[] = [];
  const broker = new Broker({
    adapters: [new ClaudeAdapter({ binary: claudeFixture })],
    audit: new AuditLog(home),
    onEvent: (event) => events.push(event),
  });
  const started = Date.now();
  const refused = await broker.dispatch(envelope(workspace, "claude", { task_id: "metered", prompt: "METERED" }));
  assert(Date.now() - started < 2_000);
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.reason, "metered_auth_refused");
  assert(events.some((event) => event.type === "error" && event.reason === "metered_auth_refused"));
  const auditText = await readFile(path.join(home, "audit", "audit.jsonl"), "utf8");
  assert.match(auditText, /metered_auth_refused/);

  events.length = 0;
  const denied = await broker.dispatch(envelope(workspace, "claude", { task_id: "permission", prompt: "PERMISSION" }));
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.reason, "permission_denied");
  assert(events.some((event) => event.type === "error" && event.reason === "permission_denied"));
});

test("M4.6 Cursor and Claude cancel their process groups", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "Projects", "cancel");
  await mkdir(workspace);
  for (const [name, adapter, input] of [
    ["cursor", new CursorAdapter({ binary: cursorFixture, ttbHome: path.join(root, "cursor-home") }), envelope(workspace, "cursor", { approval_id: "fixture-approval" })],
    ["claude", new ClaudeAdapter({ binary: claudeFixture }), envelope(workspace, "claude")],
  ] as Array<[string, Adapter, Envelope]>) {
    const pidFile = path.join(root, `${name}.pid`);
    input.prompt = `HANG PIDFILE=${pidFile}`;
    input.budget.max_time_s = 10;
    const runId = await adapter.start(input);
    const eventsPromise = collect(adapter, runId);
    await waitForFile(pidFile);
    assert.deepEqual(await adapter.cancel(runId), { stopped: true });
    const events = await eventsPromise;
    assert.deepEqual(events.slice(-2).map((event) => event.type), ["error", "finished"]);
    assert.equal((events.at(-2) as { reason: string }).reason, "cancelled");
    await assertGroupGone(Number(await readFile(pidFile, "utf8")));
  }
});

function cliEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    TTB_HOME: path.join(root, "ttb-home"),
    TTB_MUSE_MAILBOX: path.join(root, "mailbox"),
    TTB_CODEX_BIN: codexFixture,
    TTB_CURSOR_BIN: cursorFixture,
    TTB_CLAUDE_BIN: claudeFixture,
  };
}

async function jsonCli(root: string, args: string[]): Promise<{ code: number; json: Record<string, unknown>; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args, "--json"], {
    cwd: path.resolve("."),
    env: cliEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (value) => resolve(value ?? 1));
  });
  return { code, json: JSON.parse(stdout) as Record<string, unknown>, stderr };
}

test("M4.7 CLI registers both adapters, gates Cursor approval, runs Claude, and fanout includes both", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "Projects", "cli");
  await mkdir(workspace);
  const agents = await jsonCli(root, ["agents"]);
  assert.equal(agents.code, 0, agents.stderr);
  assert.deepEqual((agents.json.data as Array<{ id: string }>).map((item) => item.id), ["codex", "cursor", "claude", "muse"]);
  for (const name of ["cursor", "claude"]) {
    const profile = await jsonCli(root, ["profile", name]);
    assert.equal(profile.code, 0);
    assert.equal((profile.json.data as { agent: string }).agent, name);
  }

  const pending = await jsonCli(root, ["send", "@cursor", "WRITE", "--scope", workspace]);
  assert.equal(pending.code, 0, pending.stderr);
  const approvalId = ((pending.json.data as { approval: { id: string } }).approval).id;
  assert.match(approvalId, /^cursor-/);
  const approved = await jsonCli(root, ["approve", approvalId]);
  assert.equal(approved.code, 0, approved.stderr);
  assert.equal(((approved.json.data as { result: { changed_files: number } }).result).changed_files, 1);
  await assert.rejects(readFile(path.join(workspace, "cursor-created.txt")), /ENOENT/);

  const claude = await jsonCli(root, ["send", "@claude", "OK", "--scope", workspace]);
  assert.equal(claude.code, 0, claude.stderr);
  assert.equal(((claude.json.data as { result: { text: string } }).result).text, "CLAUDE_OK");

  const fanout = await jsonCli(root, ["fanout", "@cursor", "@claude", "Compare", "--scope", workspace]);
  assert.equal(fanout.code, 0, fanout.stderr);
  assert.match((fanout.json.data as { skeleton: string }).skeleton, /PENDING APPROVAL: cursor-/);
  assert.match((fanout.json.data as { skeleton: string }).skeleton, /CLAUDE_OK/);

  const home = path.join(root, "ttb-home");
  const inbox = path.join(root, "mailbox", "inbox");
  await mkdir(inbox, { recursive: true });
  await writeFile(path.join(home, "policy.json"), JSON.stringify({ auto_approve_inbound: ["muse"] }));
  await writeFile(path.join(inbox, "task-peer-cursor.md"), [
    "---",
    "task_id: peer-cursor",
    "thread_id: peer-cursor-thread",
    "from: muse",
    "to: cursor",
    "kind: qa",
    "hops: 0",
    "lead: muse",
    `scope_path: ${workspace}`,
    "max_time_s: 5",
    "max_cost_usd: 0",
    "mode: explicit",
    "---",
    "WRITE",
  ].join("\n"));
  const polled = await jsonCli(root, ["poll"]);
  assert.deepEqual(polled.json.data, { processed: 1, rejected: 0, pending_approvals: 1 });
  const peerApproved = await jsonCli(root, ["approve", "muse-peer-cursor"]);
  assert.equal(peerApproved.code, 0, peerApproved.stderr);
  assert.equal(((peerApproved.json.data as { result: { changed_files: number } }).result).changed_files, 1);
});
