import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLog, verifyAudit } from "../src/core/audit.ts";
import type { AuditRecordInput } from "../src/core/audit.ts";
import { Broker } from "../src/core/broker.ts";
import type { Envelope } from "../src/core/envelope.ts";
import { killRun } from "../src/cli/main.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { RunStore } from "../src/core/runs.ts";
import { Redactor } from "../src/core/redaction.ts";
import { ThreadStore } from "../src/core/threads.ts";

const cli = path.resolve("bin/ttb");
const codexFixture = path.resolve("test/fixtures/mock-codex.mjs");

function input(agent: string, index: number): AuditRecordInput {
  return {
    event: "smoke-fix.append",
    task_id: `${agent}-${index}`,
    thread_id: "smoke-fix",
    agent,
    scope: { paths: [], write: false, network: false, machine: "macbook" },
    redaction_hits: 0,
    prompt_sha256: "0".repeat(64),
    prompt_preview: `${agent}-${index}`,
    result_sha256: "0".repeat(64),
    exit: 0,
    ok: true,
    error_reason: null,
    usage: null,
  };
}

async function temporaryHome(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "ttb-audit-lock-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("separate AuditLog instances serialize interleaved appends", async (t) => {
  const home = await temporaryHome(t);
  const first = new AuditLog(home);
  const second = new AuditLog(home);

  await Promise.all([
    ...Array.from({ length: 8 }, (_, index) => first.append(input("a", index))),
    ...Array.from({ length: 8 }, (_, index) => second.append(input("b", index))),
  ]);

  assert.deepEqual(await verifyAudit(first.path), { valid: true, records: 16 });
  const records = (await readFile(first.path, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as { seq: number });
  assert.deepEqual(records.map((record) => record.seq), Array.from({ length: 16 }, (_, i) => i + 1));
});

test("separate node processes serialize concurrent appends", async (t) => {
  const home = await temporaryHome(t);
  const auditModule = path.resolve("src/core/audit.ts");
  const childCode = `
    import { AuditLog } from ${JSON.stringify(auditModule)};
    const audit = new AuditLog(process.env.TTB_SMOKE_HOME);
    const agent = process.env.TTB_SMOKE_AGENT;
    const scope = { paths: [], write: false, network: false, machine: "macbook" };
    for (let index = 0; index < 12; index += 1) {
      await audit.append({ event: "smoke-fix.child", task_id: agent + "-" + index,
        thread_id: "smoke-fix", agent, scope, redaction_hits: 0,
        prompt_sha256: "0".repeat(64), prompt_preview: agent + "-" + index,
        result_sha256: "0".repeat(64), exit: 0, ok: true, error_reason: null, usage: null });
    }
  `;
  const runChild = (agent: string): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
      cwd: path.resolve("."),
      env: { PATH: process.env.PATH ?? "", TTB_SMOKE_HOME: home, TTB_SMOKE_AGENT: agent },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child ${agent} exited with ${code ?? signal}`));
    });
  });

  await Promise.all([runChild("child-a"), runChild("child-b")]);
  const auditPath = path.join(home, "audit", "audit.jsonl");
  assert.deepEqual(await verifyAudit(auditPath), { valid: true, records: 24 });
});

test("a cross-process kill remains a failed dispatch when the worker exits 0", async (t) => {
  const home = await temporaryHome(t);
  const workspace = path.join(home, "workspace");
  await mkdir(workspace);
  const audit = new AuditLog(home);
  const runs = new RunStore(home);
  const readyFile = path.join(home, "ready");
  const adapter = new CodexAdapter({
    binary: path.resolve("test/fixtures/mock-codex-sigterm-zero.mjs"),
    env: { MOCK_READY_FILE: readyFile },
  });
  const broker = new Broker({ adapters: [adapter], audit, runs });
  const envelope: Envelope = {
    task_id: "kill-task",
    thread_id: "kill-thread",
    from: "grok",
    to: "codex",
    kind: "qa",
    prompt: "Long task",
    scope: { paths: [workspace], write: false, network: false, machine: "macbook" },
    budget: { max_time_s: 30, max_cost_usd: 0 },
    mode: "explicit",
    hops: 0,
    lead: "grok",
  };

  const pending = broker.dispatch(envelope);
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      await readFile(readyFile);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  let record: Awaited<ReturnType<RunStore["list"]>>[number] | undefined;
  while (Date.now() < deadline && !record) {
    record = (await runs.list())[0];
    if (!record) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(record, "dispatch did not register a live run");
  const killed = await killRun(record, runs, audit);
  assert.equal(killed.run_id, record.run_id);

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error?.reason, "killed");
  assert.equal(result.text, "");
  assert.equal(result.exit, 0);
  await assert.rejects(readFile(runs.killedPathFor(record.run_id)), { code: "ENOENT" });

  const records = (await readFile(audit.path, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const completed = records.find((item) => item.event === "dispatch.completed");
  assert.equal(completed?.ok, false);
  assert.equal(completed?.error_reason, "killed");
  assert.equal(completed?.result_sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("fanout comparisons are recorded and tallied", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ttb-compare-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, TTB_HOME: path.join(root, "ttb-home"), TTB_CODEX_BIN: codexFixture, HOME: root };
  const run = (args: string[]): Promise<{ code: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, "--json"], { cwd: path.resolve("."), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, json: JSON.parse(stdout) as Record<string, unknown> }));
  });
  const fanout = await run(["fanout", "@codex", "@codex", "Compare", "--scope", workspace]);
  assert.equal(fanout.code, 0);
  const threadId = (fanout.json.data as { thread_id: string }).thread_id;
  const compared = await run(["compare", threadId, "--agree", "same answer", "--disagree", "different detail", "--changed-decision", "yes"]);
  assert.equal(compared.code, 0);
  assert.deepEqual(compared.json.data, { thread_id: threadId, agree: "same answer", disagree: "different detail", changed_decision: "yes", disagreement: true });
  const thread = await run(["thread", threadId]);
  const messages = (thread.json.data as { messages: Array<Record<string, unknown>> }).messages;
  assert.equal(messages.at(-1)?.kind, "comparison");
  assert.equal(messages.at(-1)?.untrusted, false);
  const auditPath = path.join(root, "ttb-home", "audit", "audit.jsonl");
  const audit = await readFile(auditPath, "utf8");
  assert.match(audit, /comparison\.recorded/);
  const verification = await verifyAudit(auditPath);
  assert.equal(verification.valid, true);
  assert.equal(verification.records, 7);
  const tally = await run(["tally"]);
  assert.deepEqual(tally.json.data, { comparisons: 1, with_disagreement: 1, changed_decision_yes: 1, changed_decision_no: 0, unknown: 0 });
  const missing = await run(["compare", "missing-thread", "--agree", "none", "--disagree", "none"]);
  assert.equal(missing.code, 3);
});

test("hub approval ids survive pending thread messages while agent tokens remain redacted", async (t) => {
  const home = await temporaryHome(t);
  const threads = new ThreadStore(home, new Redactor());
  const approvalId = "cursor-task-1792989047116-27d2c613";
  await threads.append({
    task_id: "task-1792989047116-27d2c613",
    thread_id: "approval-thread",
    from: "cursor",
    to: "grok",
    kind: "outbound_reply",
    text: `PENDING APPROVAL: ${approvalId}`,
    untrusted: true,
  }, { hubGeneratedApprovalId: approvalId });
  await threads.append({
    task_id: "reply-task",
    thread_id: "approval-thread",
    from: "cursor",
    to: "grok",
    kind: "inbound_reply",
    text: `Agent mentioned ${approvalId} and ghp_${"FIXTURETOKEN".repeat(3)}`,
    untrusted: true,
  });

  const records = (await readFile(threads.pathFor("approval-thread"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as { text: string });
  assert.equal(records[0].text, `PENDING APPROVAL: ${approvalId}`);
  assert.match(records[1].text, /\[REDACTED:github-token\]/);
  assert.match(records[1].text, /\[REDACTED:high-entropy\]/);
  assert(!records[1].text.includes(approvalId));
});

test("Codex plan end is opt-in and is not inherited by child configuration", () => {
  const previous = process.env.TTB_CODEX_PLAN_ENDS;
  try {
    delete process.env.TTB_CODEX_PLAN_ENDS;
    assert.equal(new CodexAdapter({ binary: codexFixture }).manifest().plan_ends, undefined);
    process.env.TTB_CODEX_PLAN_ENDS = "2099-01-02";
    assert.equal(new CodexAdapter({ binary: codexFixture }).manifest().plan_ends, "2099-01-02");
  } finally {
    if (previous === undefined) delete process.env.TTB_CODEX_PLAN_ENDS;
    else process.env.TTB_CODEX_PLAN_ENDS = previous;
  }
});
