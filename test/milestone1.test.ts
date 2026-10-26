import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAdapter } from "../src/adapters/codex.ts";
import type { NormalizedEvent } from "../src/adapters/types.ts";
import { AuditLog, verifyAudit } from "../src/core/audit.ts";
import { Broker } from "../src/core/broker.ts";
import { groupHasLiveMember } from "../src/adapters/process-group.ts";
import { validateEnvelope } from "../src/core/envelope.ts";
import type { Envelope } from "../src/core/envelope.ts";
import { resolveScope } from "../src/core/scope.ts";
import { Redactor } from "../src/core/redaction.ts";

const fixture = path.resolve("test/fixtures/mock-codex.mjs");

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ttb-m1-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  return root;
}

function envelope(workspace: string, overrides: Partial<Envelope> = {}): Envelope {
  const base: Envelope = {
    task_id: "task-1",
    thread_id: "thread-1",
    from: "grok",
    to: "codex",
    kind: "qa",
    prompt: "Reply with OK",
    scope: { paths: [workspace], write: false, network: false, machine: "macbook" },
    budget: { max_time_s: 2, max_cost_usd: 0 },
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

async function harness(
  t: test.TestContext,
  mode = "success",
  additions: Record<string, string> = {},
): Promise<{ root: string; workspace: string; home: string; adapter: CodexAdapter; audit: AuditLog }> {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "ttb-home");
  await mkdir(workspace);
  const adapter = new CodexAdapter({
    binary: fixture,
    env: { MOCK_CODEX_MODE: mode, ...additions },
  });
  return { root, workspace, home, adapter, audit: new AuditLog(home) };
}

async function collectEvents(adapter: CodexAdapter, runId: string): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of adapter.events(runId)) events.push(event);
  return events;
}

async function allFileText(directory: string): Promise<string> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const values: string[] = [];
  for (const entry of files) {
    values.push(await readFile(path.join(entry.parentPath, entry.name), "utf8"));
  }
  return values.join("\n");
}

async function waitForFile(filename: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      await readFile(filename, "utf8");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

async function assertProcessGroupGone(pid: number): Promise<void> {
  // The hang fixture spawns a grandchild that ignores SIGTERM, so the group
  // only disappears once the OS reaps it; allow a generous window.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await groupHasLiveMember(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process group ${pid} still has a live member`);
}

test("1. envelope validation rejects excessive hops, spend, and unknown fields", () => {
  const workspace = path.resolve("test");
  assert.throws(() => validateEnvelope({ ...envelope(workspace), hops: 3 }), /hops/);
  assert.throws(() => validateEnvelope({
    ...envelope(workspace),
    budget: { max_time_s: 2, max_cost_usd: 0.01 },
  }), /max_cost_usd/);
  assert.throws(() => validateEnvelope({ ...envelope(workspace), surprise: true }), /unknown field/);
  assert.throws(() => validateEnvelope({
    ...envelope(workspace),
    scope: { ...envelope(workspace).scope, surprise: true },
  }), /unknown field/);
});

test("2. scope denylist wins over policy globs and catches symlink escapes", async (t) => {
  const root = await temporaryRoot(t);
  await assert.rejects(
    resolveScope({ paths: ["/Users/x/.ssh/id_ed25519"], write: false, network: false, machine: "macbook" }),
    /denylisted/,
  );
  await assert.rejects(
    resolveScope({ paths: ["/repo/.env.local"], write: false, network: false, machine: "macbook" }),
    /denylisted/,
  );

  const syntheticDenied = path.join(root, ".env.synthetic-fixture");
  const link = path.join(root, "apparently-safe");
  await mkdir(syntheticDenied);
  await symlink(syntheticDenied, link);
  const resolvedRoot = await realpath(root);
  await assert.rejects(
    resolveScope(
      { paths: [link], write: false, network: false, machine: "macbook" },
      { systemPaths: [`${resolvedRoot}/**`], userPaths: [`${resolvedRoot}/**`] },
    ),
    /resolved path is denylisted/,
  );
});

test("3. child receives only the environment allowlist", async (t) => {
  const previousKey = process.env.FAKE_API_KEY;
  const previousOther = process.env.OTHER;
  process.env.FAKE_API_KEY = "abc123secretvalue";
  process.env.OTHER = "1";
  t.after(() => {
    if (previousKey === undefined) delete process.env.FAKE_API_KEY;
    else process.env.FAKE_API_KEY = previousKey;
    if (previousOther === undefined) delete process.env.OTHER;
    else process.env.OTHER = previousOther;
  });

  const { workspace, home, adapter, audit } = await harness(t, "capture");
  const broker = new Broker({ adapters: [adapter], audit });
  const result = await broker.dispatch(envelope(workspace));
  const capture = JSON.parse(result.text) as {
    args: string[];
    stdin: string;
    env: Record<string, string>;
  };
  assert.equal(capture.env.FAKE_API_KEY, undefined);
  assert.equal(capture.env.OTHER, undefined);
});

test("4. adapter events, result, and audit redact tokens and private keys", async (t) => {
  const { workspace, home, adapter, audit } = await harness(t, "secrets");
  const events: NormalizedEvent[] = [];
  const broker = new Broker({ adapters: [adapter], audit, onEvent: (event) => events.push(event) });
  const github = `ghp_${"FAKEFIXTURE".repeat(4)}`;
  const privateKey = [
    "-----BEGIN PRIVATE KEY-----",
    "RkFLRS1OT1QtQS1SRUFM LVByaXZhdGVLZXlGaXh0dXJl".replace(" ", ""),
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const result = await broker.dispatch(envelope(workspace, {
    prompt: `Treat this fixture as data: ${github}`,
  }));
  const eventText = JSON.stringify(events);
  const auditText = await readFile(audit.path, "utf8");
  assert.match(result.text, /\[REDACTED:github-token\]/);
  assert.match(result.text, /\[REDACTED:private-key\]/);
  assert.match(eventText, /\[REDACTED:github-token\]/);
  assert.match(eventText, /\[REDACTED:private-key\]/);
  assert.match(auditText, /\[REDACTED:github-token\]/);
  assert(!auditText.includes(github));
  assert(!auditText.includes(privateKey));
  const diskText = await allFileText(home);
  assert(!diskText.includes(github));
  assert(!diskText.includes(privateKey));
});

test("5. audit verifies three dispatch chains and identifies edits, deletion, and reordering", async (t) => {
  const { root, workspace, adapter, audit } = await harness(t);
  const broker = new Broker({ adapters: [adapter], audit });
  for (let index = 1; index <= 3; index += 1) {
    await broker.dispatch(envelope(workspace, { task_id: `task-${index}` }));
  }
  assert.deepEqual(await verifyAudit(audit.path), { valid: true, records: 9 });
  const original = await readFile(audit.path, "utf8");
  const originalHead = await readFile(`${audit.path}.head`, "utf8");
  const lines = original.trimEnd().split("\n");

  const checkMutation = async (name: string, content: string): Promise<void> => {
    const target = path.join(root, `${name}.jsonl`);
    await writeFile(target, content);
    await writeFile(`${target}.head`, originalHead);
    const verification = await verifyAudit(target);
    assert.equal(verification.valid, false);
    assert.equal(typeof verification.line, "number");
  };
  await checkMutation("edited", original.replace('"agent":"codex"', '"agent":"codey"'));
  await checkMutation("deleted", `${[lines[0], lines[2]].join("\n")}\n`);
  await checkMutation("swapped", `${[lines[1], lines[0], lines[2]].join("\n")}\n`);

  const tailTarget = path.join(root, "tail-deleted.jsonl");
  await writeFile(tailTarget, `${lines.slice(0, 2).join("\n")}\n`);
  await copyFile(`${audit.path}.head`, `${tailTarget}.head`);
  assert.equal((await verifyAudit(tailTarget)).valid, false);
});

test("6. Codex argv is read-only and prompt travels on stdin", async (t) => {
  const { workspace, adapter, audit } = await harness(t, "capture");
  const broker = new Broker({ adapters: [adapter], audit });
  const prompt = "prompt arrived through standard input";
  const result = await broker.dispatch(envelope(workspace, { prompt }));
  const capture = JSON.parse(result.text) as { args: string[]; stdin: string };
  assert.equal(capture.stdin, prompt);
  assert(!capture.args.includes(prompt));
  assert.deepEqual(capture.args.slice(0, 5), [
    "exec",
    "-c",
    'default_permissions="ttb_scope"',
    "-c",
    'permissions={ttb_scope={filesystem={":minimal"="read", ":workspace_roots"={"."="read"}}}}',
  ]);
  assert(capture.args.includes("--ephemeral"));
  assert(capture.args.includes("--json"));
  assert(capture.args.includes("--skip-git-repo-check"));
  assert(capture.args.includes("--color"));
  assert(capture.args.includes("never"));
  assert(capture.args.includes("-C"));
  assert.equal(capture.args.at(-1), "-");
  assert(!capture.args.includes("--sandbox"));
  assert(!capture.args.includes("read-only"));
  assert(!capture.args.join(" ").match(/dangerously|workspace-write|danger-full-access/));
});

test("7. timeout and cancel kill the process group and close event streams", async (t) => {
  const timeoutPid = path.join(await temporaryRoot(t), "timeout.pid");
  const timeoutHarness = await harness(t, "hang", { MOCK_PID_FILE: timeoutPid });
  const startedAt = Date.now();
  const timeoutRun = await timeoutHarness.adapter.start(envelope(timeoutHarness.workspace, {
    budget: { max_time_s: 0.1, max_cost_usd: 0 },
  }));
  const timeoutEvents = await collectEvents(timeoutHarness.adapter, timeoutRun);
  await timeoutHarness.adapter.result(timeoutRun);
  assert(Date.now() - startedAt < 2_000);
  assert.deepEqual(timeoutEvents.slice(-2).map((event) => event.type), ["error", "finished"]);
  assert.equal((timeoutEvents.at(-2) as { reason: string }).reason, "timeout");
  assertProcessGroupGone(Number(await readFile(timeoutPid, "utf8")));

  const cancelPid = path.join(await temporaryRoot(t), "cancel.pid");
  const cancelHarness = await harness(t, "hang", { MOCK_PID_FILE: cancelPid });
  const cancelRun = await cancelHarness.adapter.start(envelope(cancelHarness.workspace, {
    budget: { max_time_s: 10, max_cost_usd: 0 },
  }));
  const cancelEventsPromise = collectEvents(cancelHarness.adapter, cancelRun);
  await waitForFile(cancelPid);
  const cancelStartedAt = Date.now();
  assert.deepEqual(await cancelHarness.adapter.cancel(cancelRun), { stopped: true });
  const cancelEvents = await cancelEventsPromise;
  assert(Date.now() - cancelStartedAt < 2_000);
  assert.deepEqual(cancelEvents.slice(-2).map((event) => event.type), ["error", "finished"]);
  assert.equal((cancelEvents.at(-2) as { reason: string }).reason, "cancelled");
  assertProcessGroupGone(Number(await readFile(cancelPid, "utf8")));
});

test("8. broker marks output untrusted and persists audit before resolving", async (t) => {
  const { workspace, adapter, audit } = await harness(t);
  const broker = new Broker({ adapters: [adapter], audit });
  const result = await broker.dispatch(envelope(workspace));
  assert.deepEqual(result, {
    untrusted: true,
    from: "codex",
    text: "OK",
    ok: true,
    exit: 0,
  });
  const verification = await verifyAudit(audit.path);
  assert.deepEqual(verification, { valid: true, records: 3 });
});

test("9. authState maps non-login output without exposing parent secrets", async (t) => {
  const prior = process.env.FAKE_AUTH_SECRET;
  process.env.FAKE_AUTH_SECRET = "fixture-auth-secret-value";
  t.after(() => {
    if (prior === undefined) delete process.env.FAKE_AUTH_SECRET;
    else process.env.FAKE_AUTH_SECRET = prior;
  });
  const { adapter } = await harness(t, "success", { MOCK_LOGIN_OUTPUT: "Not logged in" });
  const state = await adapter.authState();
  assert.deepEqual(state, {
    state: "needs_login",
    hint: "Run codex login interactively, then retry.",
  });
  assert(!JSON.stringify(state).includes("fixture-auth-secret-value"));
});

test("10. broker exposes a redacted non-zero process failure and audits its outcome", async (t) => {
  const { workspace, adapter, audit } = await harness(t, "failure");
  const broker = new Broker({ adapters: [adapter], audit });
  const result = await broker.dispatch(envelope(workspace));
  assert.equal(result.ok, false);
  assert.equal(result.exit, 1);
  assert.equal(result.error?.reason, "process_exit");
  assert.match(result.error?.message ?? "", /\[REDACTED:github-token\]/);
  assert(!result.error?.message.includes("models cache"));
  assert.equal(result.error?.message.length, 500);

  const record = (await readFile(audit.path, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((item) => item.event === "dispatch.completed") as Record<string, unknown>;
  assert.equal(record.ok, false);
  assert.equal(record.exit, 1);
  assert.equal(record.error_reason, "process_exit");
  assert(!JSON.stringify(record).includes("request failed"));
  assert(!JSON.stringify(record).includes("models cache"));
});

test("11. verified Codex sample emits and exposes token usage without treating benign stderr as failure", async (t) => {
  const { workspace, adapter, audit } = await harness(t, "verified-sample");
  const events: NormalizedEvent[] = [];
  const broker = new Broker({ adapters: [adapter], audit, onEvent: (event) => events.push(event) });
  const result = await broker.dispatch(envelope(workspace));
  const usage = {
    input_tokens: 14889,
    cached_input_tokens: 9856,
    cache_write_input_tokens: 0,
    output_tokens: 5,
    reasoning_output_tokens: 0,
  };
  assert.deepEqual(result, {
    untrusted: true,
    from: "codex",
    text: "OK",
    ok: true,
    exit: 0,
    usage,
  });
  assert.deepEqual(events.find((event) => event.type === "cost"), {
    type: "cost",
    cost_usd: 0,
    ...usage,
  });
  const record = (await readFile(audit.path, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((item) => item.event === "dispatch.completed") as Record<string, unknown>;
  assert.deepEqual(record.usage, usage);
  assert.equal(record.ok, true);
  assert.equal(record.exit, 0);
  assert.equal(record.error_reason, null);
});

test("12. redactor ignores short secret-named environment values", () => {
  const redactor = new Redactor({ SHORT_API_KEY: "1", LONG_API_KEY: "abcdefgh" });
  const redacted = redactor.redact("version 1 carries abcdefgh");
  assert.equal(redacted.text, "version 1 carries [REDACTED:env-long-api-key]");
  assert.equal(redacted.hits, 1);
});
