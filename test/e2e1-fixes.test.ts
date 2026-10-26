import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CursorAdapter } from "../src/adapters/cursor.ts";
import type { Adapter, AdapterResult, AdapterUsage, AuthState, NormalizedEvent } from "../src/adapters/types.ts";
import type { Hub } from "../src/cli/main.ts";
import { resolveApproval } from "../src/cli/main.ts";
import { ApprovalStore } from "../src/core/approvals.ts";
import { AuditLog } from "../src/core/audit.ts";
import { Broker } from "../src/core/broker.ts";
import type { Envelope } from "../src/core/envelope.ts";
import { Redactor } from "../src/core/redaction.ts";
import { RunStore } from "../src/core/runs.ts";
import { ThreadStore } from "../src/core/threads.ts";
import { APP_JS } from "../src/web/assets.ts";
import { startUiServer } from "../src/web/server.ts";

const cursorFixture = path.resolve("test/fixtures/mock-cursor.mjs");

async function rootFor(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ttb-e2e1-"));
  await mkdir(path.join(root, "Projects", "workspace"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  return root;
}

function envelope(workspace: string, taskId: string, prompt = "Reply with OK"): Envelope {
  return {
    task_id: taskId,
    thread_id: "e2e-1",
    from: "grok",
    to: "cursor",
    kind: "qa",
    prompt,
    scope: { paths: [workspace], write: false, network: false, machine: "macbook" },
    budget: { max_time_s: 5, max_cost_usd: 0 },
    mode: "explicit",
    hops: 0,
    lead: "grok",
    read_only: true,
  };
}

async function makeHub(root: string, adapter: Adapter = new CursorAdapter({
  binary: cursorFixture,
  ttbHome: path.join(root, "ttb-home"),
})): Promise<Hub> {
  const home = path.join(root, "ttb-home");
  const redactor = new Redactor();
  const audit = new AuditLog(home);
  const threads = new ThreadStore(home, redactor);
  const runs = new RunStore(home);
  const approvals = new ApprovalStore(home, audit, redactor);
  const broker = new Broker({
    adapters: [adapter],
    audit,
    redactor,
    threads,
    runs,
    approvalCheck: (id, item) => approvals.isApproved(id, item),
  });
  return {
    home,
    audit,
    broker,
    threads,
    approvals,
    runs,
    redactor,
    adapters: [adapter],
    muse: { stop: async () => {} } as never,
  };
}

async function approve(hub: Hub, item: Envelope): Promise<string> {
  const pending = await hub.approvals.createForAgent("cursor", item);
  return pending.id;
}

test("E2E1 approval resolution appends cursor replies, errors, and denials to the thread", async (t) => {
  const root = await rootFor(t);
  const workspace = path.join(root, "Projects", "workspace");
  const hub = await makeHub(root);

  const success = await approve(hub, envelope(workspace, "approved-task"));
  await resolveApproval(hub, success, "approve");
  const failingItem = {
    ...envelope(workspace, "failing-task", "ERROR"),
    scope: { paths: [path.join(root, ".env.local")], write: false as const, network: false, machine: "macbook" as const },
  };
  const failing = await approve(hub, failingItem);
  await resolveApproval(hub, failing, "approve").catch(() => {});
  const denied = await approve(hub, envelope(workspace, "denied-task"));
  await resolveApproval(hub, denied, "deny");
  const records = (await readFile(hub.threads.pathFor("e2e-1"), "utf8")).trim().split("\n").map(JSON.parse) as Array<Record<string, unknown>>;
  assert(records.some((record) => record.task_id === "approved-task" && String(record.text).includes("Cursor completed")));
  assert(records.some((record) => record.task_id === "failing-task" && String(record.text).startsWith("ERROR:")));
  assert(records.some((record) => record.task_id === "denied-task" && record.text === `DENIED: ${denied}`));
  assert(records.every((record) => record.kind === "outbound_reply"));
});

test("E2E1 Cursor ignores thinking, warns once per unknown type, and returns only the post-tool answer", async (t) => {
  const root = await rootFor(t);
  const workspace = path.join(root, "Projects", "workspace");
  const warnings: string[] = [];
  const adapter = new CursorAdapter({
    binary: cursorFixture,
    ttbHome: path.join(root, "ttb-home"),
    logger: (message) => warnings.push(message),
  });
  const hub = await makeHub(root, adapter);
  const item = envelope(workspace, "thinking-task", "THINKING");
  const approvalId = await approve(hub, item);
  const claim = await hub.approvals.claim(approvalId);
  await hub.approvals.finish(claim, "approved");
  const result = await hub.broker.dispatch({ ...item, approval_id: approvalId });
  assert.equal(result.text, "Final answer from Cursor.");
  assert(!result.text.includes("private thought"));
  assert(!result.text.includes("I'll scan"));
  assert.equal(warnings.filter((message) => message.includes("thinking")).length, 0);
  assert.equal(warnings.filter((message) => message.includes('"mystery"')).length, 1);
});

class ArtifactAdapter implements Adapter {
  private artifact: string;
  constructor(artifact: string) { this.artifact = artifact; }
  manifest() { return { id: "artifact-test", ability: "cli" as const, capabilities: ["qa"], isolation: "test", cost_class: "prepaid", streaming: "final-only" as const, notes: "test" }; }
  async authState(): Promise<AuthState> { return { state: "ok", hint: "test" }; }
  async start(): Promise<string> { return "artifact-run"; }
  async *events(): AsyncIterable<NormalizedEvent> {
    yield { type: "started", run_id: "artifact-run" };
    yield { type: "finished", exit: 0 };
  }
  async result(): Promise<AdapterResult> {
    return { text: "plain", artifacts: [this.artifact], exit: 0 };
  }
  async cancel(): Promise<{ stopped: boolean }> { return { stopped: true }; }
  async usage(): Promise<AdapterUsage> { return { cost_usd: 0, quota: "unknown" }; }
}

test("E2E1 broker preserves hub artifacts but redacts external artifact paths", async (t) => {
  const root = await rootFor(t);
  const workspace = path.join(root, "Projects", "workspace");
  const home = path.join(root, "ttb-home");
  const cursorHub = await makeHub(root);
  const cursorItem = envelope(workspace, "cursor-artifact-task");
  const cursorApproval = await approve(cursorHub, cursorItem);
  const cursorClaim = await cursorHub.approvals.claim(cursorApproval);
  await cursorHub.approvals.finish(cursorClaim, "approved");
  const cursorResult = await cursorHub.broker.dispatch({ ...cursorItem, approval_id: cursorApproval });
  assert(cursorResult.artifacts?.[0]?.startsWith(path.join(cursorHub.home, "artifacts") + path.sep));
  await stat(cursorResult.artifacts?.[0] as string);
  const token = "AbCdEf0123456789GhIjKlMnOpQrStUvWxYz9876";
  const hubArtifact = path.join(home, "artifacts", "fixture.diff");
  await mkdir(path.dirname(hubArtifact), { recursive: true });
  await writeFile(hubArtifact, "diff");
  const external = path.join(root, token);
  const hub = await makeHub(root, new ArtifactAdapter(hubArtifact));
  const result = await hub.broker.dispatch({
    ...envelope(workspace, "artifact-task"),
    to: "artifact-test",
  });
  assert.equal(result.artifacts?.[0], hubArtifact);
  await stat(result.artifacts?.[0] as string);

  const externalHub = await makeHub(root, new ArtifactAdapter(external));
  const externalResult = await externalHub.broker.dispatch({
    ...envelope(workspace, "external-artifact-task"),
    to: "artifact-test",
  });
  assert(!externalResult.artifacts?.[0]?.includes(token));
  const redactor = new Redactor({});
  assert.equal(redactor.redact(token).text, "[REDACTED:high-entropy]");
  assert.equal(redactor.redact(`ttb/artifacts/${token}`).text, "[REDACTED:high-entropy]");
});

test("E2E1 live thread page is no-store and approval result is visible through UI and API", async (t) => {
  const root = await rootFor(t);
  const workspace = path.join(root, "Projects", "workspace");
  const hub = await makeHub(root);
  const pending = await approve(hub, envelope(workspace, "ui-task"));
  let ui;
  try {
    ui = await startUiServer({ hub, port: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("execution sandbox prohibits loopback TCP listeners");
    throw error;
  }
  t.after(() => ui.close());
  const tokenUrl = new URL(ui.url);
  const exchanged = await fetch(`http://127.0.0.1:${ui.port}${tokenUrl.pathname}${tokenUrl.search}`, { redirect: "manual" });
  const cookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  // Resolve from a separate Hub instance on the same TTB_HOME, as `ttb approve`
  // does from another terminal while `ttb ui` keeps running.
  const otherProcessHub = await makeHub(root);
  await resolveApproval(otherProcessHub, pending, "approve");
  const pendingId = "cursor-task-1792989047116-27d2c613";
  await hub.threads.append({ task_id: "task-1792989047116-27d2c613", thread_id: "e2e-1", from: "cursor", to: "grok", kind: "outbound_reply", text: `PENDING APPROVAL: ${pendingId}`, untrusted: true }, { hubGeneratedApprovalId: pendingId });
  const headers = { Cookie: cookie };
  const api = await fetch(`http://127.0.0.1:${ui.port}/api/threads/e2e-1`, { headers });
  assert.match(await api.text(), /Cursor completed/);
  const page = await fetch(`http://127.0.0.1:${ui.port}/threads/e2e-1`, { headers });
  assert.equal(page.headers.get("cache-control"), "no-store");
  const pageText = await page.text();
  assert.match(pageText, /Cursor completed/);
  assert(pageText.includes(`PENDING APPROVAL: ${pendingId}`), "hub approval id is shown verbatim");
  assert(!pageText.includes("ghp_"), "agent token stays redacted in the UI");
  assert.match(APP_JS, /DOMParser/);
  assert.match(APP_JS, /setInterval\(refresh, 2000\)/);
});
