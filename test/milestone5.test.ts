import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { ClaudeAdapter } from "../src/adapters/claude.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { CursorAdapter } from "../src/adapters/cursor.ts";
import { MuseVaultDropAdapter } from "../src/adapters/muse-vaultdrop.ts";
import type { Adapter } from "../src/adapters/types.ts";
import type { Hub } from "../src/cli/main.ts";
import { ApprovalStore } from "../src/core/approvals.ts";
import { AuditLog } from "../src/core/audit.ts";
import { Broker } from "../src/core/broker.ts";
import type { Envelope } from "../src/core/envelope.ts";
import { Redactor } from "../src/core/redaction.ts";
import { RunStore } from "../src/core/runs.ts";
import { ThreadStore } from "../src/core/threads.ts";
import { APP_CSS, APP_JS, ICON_SVG, MANIFEST, SERVICE_WORKER } from "../src/web/assets.ts";
import { escapeHtml, startUiServer } from "../src/web/server.ts";

const cli = path.resolve("bin/ttb");
const codexFixture = path.resolve("test/fixtures/mock-codex.mjs");
const hangFixture = path.resolve("test/fixtures/mock-codex-hang.mjs");
const cursorFixture = path.resolve("test/fixtures/mock-cursor.mjs");
const claudeFixture = path.resolve("test/fixtures/mock-claude.mjs");

async function loopbackIsAvailable(): Promise<boolean> {
  const server = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const LOOPBACK_AVAILABLE = await loopbackIsAvailable();

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ttb-m5-"));
  await mkdir(path.join(root, "Projects", "workspace"), { recursive: true });
  await mkdir(path.join(root, "Agents", "vault"), { recursive: true });
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  return root;
}

async function makeHub(root: string, codexBinary = codexFixture): Promise<Hub> {
  const home = path.join(root, "ttb-home");
  const redactor = new Redactor();
  const audit = new AuditLog(home);
  const threads = new ThreadStore(home, redactor);
  const runs = new RunStore(home);
  const adapters: Adapter[] = [
    new CodexAdapter({ binary: codexBinary, redactor }),
    new CursorAdapter({ binary: cursorFixture, redactor, ttbHome: home }),
    new ClaudeAdapter({ binary: claudeFixture, redactor }),
  ];
  const muse = new MuseVaultDropAdapter({ mailboxRoot: path.join(root, "mailbox") });
  adapters.push(muse);
  const approvals = new ApprovalStore(home, audit, redactor);
  const broker = new Broker({
    adapters,
    audit,
    redactor,
    threads,
    runs,
    approvalCheck: (id, envelope) => approvals.isApproved(id, envelope),
  });
  return { home, audit, broker, muse, adapters, threads, approvals, runs, redactor };
}

function envelope(root: string, taskId: string, to = "cursor", prompt = "Review the workspace"): Envelope {
  return {
    task_id: taskId,
    thread_id: "ui-thread",
    from: "grok",
    to,
    kind: "qa",
    prompt,
    scope: { paths: [path.join(root, "Projects", "workspace")], write: false, network: false, machine: "macbook" },
    budget: { max_time_s: 10, max_cost_usd: 0 },
    mode: "explicit",
    hops: 0,
    lead: "grok",
    read_only: true,
  };
}

type WebResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(
  port: number,
  pathname: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<WebResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method: options.method ?? "GET",
      headers: { Host: `127.0.0.1:${port}`, Connection: "close", ...options.headers },
      agent: false,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function authenticate(port: number, printedUrl: string): Promise<string> {
  const tokenUrl = new URL(printedUrl);
  const exchanged = await request(port, `${tokenUrl.pathname}${tokenUrl.search}`);
  assert.equal(exchanged.status, 303);
  assert.equal(exchanged.headers.location, "/");
  const setCookie = exchanged.headers["set-cookie"]?.[0] ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert(!setCookie.includes("token="));
  return setCookie.split(";", 1)[0];
}

function csrfFrom(html: string): string {
  const match = /<meta name="ttb-csrf" content="([^"]+)">/.exec(html);
  assert(match, "page did not include a CSRF token");
  return match[1];
}

async function waitFor(predicate: () => Promise<boolean>, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function processGroupGone(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

test("M5.0 HTML escaping, local assets, token-file mode, and remote-host gate work without a socket", async (t) => {
  assert.equal(
    escapeHtml('&<>"\'`'),
    "&amp;&lt;&gt;&quot;&#39;&#96;",
  );
  for (const asset of [APP_CSS, APP_JS, ICON_SVG, MANIFEST, SERVICE_WORKER]) {
    assert(!asset.includes("https://"));
  }
  assert(!SERVICE_WORKER.includes("/api"));
  assert(!SERVICE_WORKER.includes("/agents"));

  const root = await temporaryRoot(t);
  const hub = await makeHub(root);
  await mkdir(hub.home, { recursive: true });
  const tokenFile = path.join(hub.home, "ui-token");
  await writeFile(tokenFile, "fixture-token-value-with-more-than-thirty-two-bytes\n");
  await chmod(tokenFile, 0o644);
  await assert.rejects(startUiServer({ hub, port: 0 }), /mode 0600/);
  await rm(tokenFile);
  await assert.rejects(
    startUiServer({ hub, host: "0.0.0.0", port: 0, env: {} }),
    /remote access is not supported in P1/,
  );
});

test("M5.1 UI binds loopback, gates sessions, rejects bad Host, and serves only public PWA assets anonymously", async (t) => {
  const root = await temporaryRoot(t);
  const hub = await makeHub(root);
  await assert.rejects(
    startUiServer({ hub, host: "0.0.0.0", port: 0, env: {} }),
    /Non-loopback UI hosts require/,
  );
  if (!LOOPBACK_AVAILABLE) return t.skip("execution sandbox prohibits loopback TCP listeners");

  const ui = await startUiServer({ hub, port: 0 });
  t.after(() => ui.close());
  assert.equal(ui.host, "127.0.0.1");
  assert(ui.port > 0);
  assert.match(ui.url, new RegExp(`^http://127\\.0\\.0\\.1:${ui.port}/\\?token=`));

  assert.equal((await request(ui.port, "/agents")).status, 401);
  assert.equal((await request(ui.port, "/app.css")).status, 401);
  assert.equal((await request(ui.port, "/manifest.webmanifest")).status, 200);
  assert.equal((await request(ui.port, "/icon.svg")).status, 200);
  const worker = await request(ui.port, "/sw.js");
  assert.equal(worker.status, 200);
  assert(!worker.body.includes("/api"));
  assert(!worker.body.includes("/agents"));

  const badHost = await request(ui.port, "/manifest.webmanifest", { headers: { Host: `attacker.example:${ui.port}` } });
  assert.equal(badHost.status, 421);
  const badToken = await request(ui.port, "/?token=wrong");
  assert.equal(badToken.status, 401);

  const cookie = await authenticate(ui.port, ui.url);
  const page = await request(ui.port, "/agents", { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"] ?? "", /^text\/html/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.match(page.headers["content-security-policy"] ?? "", /default-src 'self'/);
  assert.match(page.headers["content-security-policy"] ?? "", /frame-ancestors 'none'/);
  assert(!/https?:\/\//.test(page.body));
});

test("M5.2 every view and JSON endpoint renders, while untrusted agent text stays plain and escaped", async (t) => {
  if (!LOOPBACK_AVAILABLE) return t.skip("execution sandbox prohibits loopback TCP listeners");
  const root = await temporaryRoot(t);
  const hub = await makeHub(root);
  const hostile = '<script>alert(1)</script> "><img src=x onerror=alert(1)> javascript:alert(1) `tick`';
  await hub.threads.append({
    task_id: "hostile-task",
    thread_id: "ui-thread",
    from: "codex",
    to: "grok",
    kind: "inbound_reply",
    text: hostile,
    untrusted: true,
  });
  await hub.approvals.createForAgent("cursor", envelope(root, "hostile-approval", "cursor", hostile));
  await mkdir(path.join(hub.home, "profiles"), { recursive: true });
  await writeFile(path.join(hub.home, "profiles", "codex.json"), JSON.stringify({
    user: { note: hostile },
    learned: [{ value: hostile, provenance: "fixture", date: "2026-10-24" }],
  }));

  const ui = await startUiServer({ hub, port: 0 });
  t.after(() => ui.close());
  const cookie = await authenticate(ui.port, ui.url);
  const headers = { Cookie: cookie };

  for (const pathname of ["/agents", "/threads", "/threads/ui-thread", "/approvals", "/runs", "/audit"]) {
    const response = await request(ui.port, pathname, { headers });
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers["content-type"] ?? "", /^text\/html/, pathname);
    assert(!response.body.includes("<script>alert(1)</script>"), pathname);
    assert(!response.body.includes('<img src=x onerror=alert(1)>'), pathname);
    assert(!/https?:\/\//.test(response.body), pathname);
  }

  const threadPage = await request(ui.port, "/threads/ui-thread", { headers });
  assert.match(threadPage.body, /untrusted agent output/);
  assert.match(threadPage.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(threadPage.body, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(threadPage.body, /javascript:alert\(1\)/);
  assert.match(threadPage.body, /&#96;tick&#96;/);

  for (const pathname of ["/api/agents", "/api/threads", "/api/threads/ui-thread", "/api/approvals", "/api/runs", "/api/audit"]) {
    const response = await request(ui.port, pathname, { headers });
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers["content-type"] ?? "", /^application\/json/, pathname);
    assert.doesNotThrow(() => JSON.parse(response.body), pathname);
  }
  const threadJson = JSON.parse((await request(ui.port, "/api/threads/ui-thread", { headers })).body) as
    { messages: Array<{ text: string; untrusted: boolean }> };
  assert.equal(threadJson.messages[0].text, hostile);
  assert.equal(threadJson.messages[0].untrusted, true);
});

test("M5.3 approval and kill actions are POST-only, enforce CSRF and Origin, and reuse audited core behavior", async (t) => {
  if (!LOOPBACK_AVAILABLE) return t.skip("execution sandbox prohibits loopback TCP listeners");
  const root = await temporaryRoot(t);
  const hub = await makeHub(root, hangFixture);
  const approve = await hub.approvals.createForAgent("cursor", envelope(root, "approve-from-ui"));
  const deny = await hub.approvals.createForAgent("cursor", envelope(root, "deny-from-ui"));
  const ui = await startUiServer({ hub, port: 0 });
  t.after(() => ui.close());
  const cookie = await authenticate(ui.port, ui.url);
  const page = await request(ui.port, "/approvals", { headers: { Cookie: cookie } });
  const csrf = csrfFrom(page.body);
  const origin = `http://127.0.0.1:${ui.port}`;

  for (const pathname of [
    `/api/approvals/${approve.id}/approve`,
    `/api/approvals/${deny.id}/deny`,
    "/api/runs/example-run/kill",
    "/api/runs/kill-all",
  ]) {
    assert.equal((await request(ui.port, pathname, { headers: { Cookie: cookie } })).status, 405, pathname);
  }

  const approvePath = `/api/approvals/${approve.id}/approve`;
  assert.equal((await request(ui.port, approvePath, {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin },
  })).status, 403);
  assert.equal((await request(ui.port, approvePath, {
    method: "POST",
    headers: { Cookie: cookie, Origin: "http://attacker.example", "X-TTB-CSRF": csrf },
  })).status, 403);
  assert.equal((await request(ui.port, approvePath, {
    method: "POST",
    headers: { Cookie: cookie, "X-TTB-CSRF": csrf },
  })).status, 403);

  const approved = await request(ui.port, approvePath, {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin, Referer: `${origin}/approvals`, "X-TTB-CSRF": csrf },
  });
  assert.equal(approved.status, 200, approved.body);
  assert.equal((JSON.parse(approved.body) as { ok: boolean }).ok, true);
  assert.equal((await hub.approvals.read(approve.id)).status, "approved");

  const denied = await request(ui.port, `/api/approvals/${deny.id}/deny`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin, "X-TTB-CSRF": csrf },
  });
  assert.equal(denied.status, 200, denied.body);
  assert.equal((await hub.approvals.read(deny.id)).status, "denied");

  const pendingDispatch = hub.broker.dispatch(envelope(root, "hanging-ui-run", "codex", "HANG"));
  let pgid = 0;
  await waitFor(async () => {
    const [record] = await hub.runs.list();
    if (!record?.pgid) return false;
    pgid = record.pgid;
    return true;
  }, "registered hanging run");
  const livePage = await request(ui.port, "/runs", { headers: { Cookie: cookie } });
  assert.match(livePage.body, /hanging-ui-run/);

  const killed = await request(ui.port, "/api/runs/kill-all", {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin, "X-TTB-CSRF": csrf },
  });
  assert.equal(killed.status, 200, killed.body);
  await pendingDispatch;
  await waitFor(async () => processGroupGone(pgid), "mock process group to stop", 2_000);
  assert.deepEqual(await hub.runs.list(), []);

  const auditText = await readFile(hub.audit.path, "utf8");
  assert.match(auditText, /"event":"approval.approved"/);
  assert.match(auditText, /"event":"approval.denied"/);
  assert.match(auditText, /"event":"run.killed"/);
});

test("M5.4 ttb ui prints its tokenized URL once and shuts down cleanly on SIGTERM", async (t) => {
  if (!LOOPBACK_AVAILABLE) return t.skip("execution sandbox prohibits loopback TCP listeners");
  const root = await temporaryRoot(t);
  const child = spawn(process.execPath, [cli, "ui", "--port", "0", "--json"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HOME: root,
      TTB_HOME: path.join(root, "ttb-home"),
      TTB_MUSE_MAILBOX: path.join(root, "mailbox"),
      TTB_CODEX_BIN: codexFixture,
      TTB_CURSOR_BIN: cursorFixture,
      TTB_CLAUDE_BIN: claudeFixture,
      TTB_SCOPE_ROOTS: path.join(root, "Projects"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const lines = readline.createInterface({ input: child.stdout });
  const firstLine = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`UI did not start: ${stderr}`)), 3_000);
    lines.once("line", (line) => { clearTimeout(timeout); resolve(line); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  const started = JSON.parse(firstLine) as { ok: boolean; command: string; data: { url: string; port: number } };
  assert.equal(started.ok, true);
  assert.equal(started.command, "ui");
  assert.match(started.data.url, /\?token=/);
  const cookie = await authenticate(started.data.port, started.data.url);
  assert.equal((await request(started.data.port, "/threads", { headers: { Cookie: cookie } })).status, 200);
  child.kill("SIGTERM");
  const exit = await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.equal(exit, 0, stderr);
  lines.close();
  assert.equal((await stat(path.join(root, "ttb-home")).catch(() => undefined))?.isDirectory() ?? false, false);
});
