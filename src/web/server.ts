import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyAudit } from "../core/audit.ts";
import { assertSafeSlug } from "../core/ids.ts";
import {
  createHub,
  killRun,
  listThreads,
  readThread,
  resolveApproval,
} from "../cli/main.ts";
import type { Hub } from "../cli/main.ts";
import { redactThreadMessagesForDisplay } from "../core/threads.ts";
import { APP_CSS, APP_JS, ICON_SVG, MANIFEST, SERVICE_WORKER } from "./assets.ts";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const COOKIE_NAME = "ttb_session";
const PUBLIC_PATHS = new Set(["/manifest.webmanifest", "/icon.svg", "/sw.js"]);
const FONT_FILES = new Set([
  "Bungee-Regular-latin.woff2",
  "InterVariable-latin.woff2",
  "JetBrainsMono-Variable-latin.woff2",
]);
const STATIC_PATHS = new Set([...PUBLIC_PATHS, "/app.css", "/app.js", ...[...FONT_FILES].map((file) => `/fonts/${file}`)]);
const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const fontCache = new Map<string, Buffer>();

async function fontBody(file: string): Promise<Buffer> {
  let body = fontCache.get(file);
  if (!body) {
    body = await readFile(path.join(WEB_DIR, "static", "fonts", file));
    fontCache.set(file, body);
  }
  return body;
}
const ACTION_ROUTE = /^\/api\/(?:approvals\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(approve|deny)|runs\/(kill-all|[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/kill))$/;

export type UiServerOptions = {
  host?: string;
  port?: number;
  hub?: Hub;
  env?: NodeJS.ProcessEnv;
};

export type UiServer = {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

type AgentView = {
  id: string;
  manifest: ReturnType<Hub["adapters"][number]["manifest"]>;
  auth: Awaited<ReturnType<Hub["adapters"][number]["authState"]>>;
  usage: Awaited<ReturnType<Hub["adapters"][number]["usage"]>>;
  profile: { system: unknown; user: unknown; learned: unknown };
};

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("`", "&#96;");
}

function securityHeaders(dynamic = true): Record<string, string> {
  return {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    ...(dynamic ? { "Cache-Control": "no-store" } : { "Cache-Control": "public, max-age=3600" }),
  };
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  type: string,
  headers: Record<string, string> = {},
  dynamic = true,
): void {
  response.writeHead(status, { ...securityHeaders(dynamic), "Content-Type": type, ...headers });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  send(response, status, `${JSON.stringify(data)}\n`, "application/json; charset=utf-8");
}

function nav(): string {
  return [
    ["/agents", "Crew"],
    ["/threads", "Voyages"],
    ["/approvals", "Approvals"],
    ["/runs", "Live runs"],
    ["/audit", "Logbook"],
  ].map(([href, label]) => `<a href="${href}">${label}</a>`).join("");
}

function page(title: string, description: string, body: string, csrf: string, live = false): string {
  const mark = `<svg class="brand-mark" viewBox="0 0 128 128" aria-hidden="true"><circle cx="64" cy="64" r="35" fill="none" stroke="#F2B705" stroke-width="6"/><circle cx="64" cy="64" r="11" fill="none" stroke="#F2B705" stroke-width="6"/><path d="M64 18v92M18 64h92M38 38l52 52M90 38 38 90" fill="none" stroke="#1E7F86" stroke-width="6"/></svg>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0B1F3A"><meta name="ttb-csrf" content="${escapeHtml(csrf)}"><title>${escapeHtml(title)} · Battalion</title><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head><body><header><div class="shell"><div class="mast">${mark}<a class="brand" href="/agents">BATTALION</a><span class="eyebrow">local flagship · chart room</span></div><nav aria-label="Primary">${nav()}</nav></div></header><main class="shell" data-live="${live ? "true" : "false"}"><h1>${SECTION_MARK}${escapeHtml(title)}</h1><p class="lede">${escapeHtml(description)}</p><p class="flash" data-flash aria-live="polite"></p><div class="rope-divider" aria-hidden="true"></div>${body}</main><footer><div class="shell"><div class="rope-divider" aria-hidden="true"></div>Battalion prototype · loopback only · crew output is data, never orders</div></footer></body></html>`;
}

const SECTION_MARK = `<svg class="section-mark" viewBox="0 0 128 128" aria-hidden="true"><circle cx="64" cy="64" r="35" fill="none" stroke="#F2B705" stroke-width="7"/><path d="M64 20v88M20 64h88M38 38l52 52M90 38 38 90" fill="none" stroke="#1E7F86" stroke-width="7"/></svg>`;

function displayAgent(id: string): string {
  return id === "muse-vaultdrop" ? "muse" : id;
}

async function readJsonOptional(filename: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function agentsData(hub: Hub): Promise<AgentView[]> {
  return Promise.all(hub.adapters.map(async (adapter) => {
    const manifest = adapter.manifest();
    const persisted = await readJsonOptional(path.join(hub.home, "profiles", `${manifest.id}.json`)) as
      { user?: unknown; learned?: unknown } | undefined;
    const safe = hub.redactor.redactValue({
      id: displayAgent(manifest.id),
      manifest,
      auth: await adapter.authState(),
      usage: await adapter.usage(),
      profile: { system: manifest, user: persisted?.user ?? {}, learned: persisted?.learned ?? [] },
    });
    return safe.value as AgentView;
  }));
}

function agentsHtml(agents: AgentView[]): string {
  return `<div class="grid">${agents.map((agent) => { const stateClass = agent.auth.state === "ok" ? "" : agent.auth.state === "needs_login" ? "blocked" : "waiting"; const flag = agent.auth.state === "ok" ? "SAILING" : agent.auth.state === "needs_login" ? "NEEDS LOGIN" : "WAITING"; const role = `Crew · ${agent.manifest.ability} · ${agent.manifest.cost_class}`; return `<article class="card"><div class="poster-head"><h2>@${escapeHtml(agent.id)}</h2><p class="role">${escapeHtml(role)}</p><span class="status ${stateClass}">${flag}</span></div><p>${escapeHtml(agent.auth.hint)}</p><dl class="meta"><dt>Isolation</dt><dd>${escapeHtml(agent.manifest.isolation)}</dd><dt>Plan end</dt><dd>${escapeHtml(agent.manifest.plan_ends ?? "—")}</dd><dt>Streaming</dt><dd>${escapeHtml(agent.manifest.streaming)}</dd></dl><details><summary>Manifest</summary><pre>${escapeHtml(JSON.stringify(agent.profile, null, 2))}</pre></details></article>`; }).join("")}</div>`;
}

async function approvalsData(hub: Hub): Promise<unknown[]> {
  const records = await hub.approvals.list("pending");
  return records.map((record) => ({
    id: record.id,
    status: record.status,
    agent: record.agent,
    created_at: record.created_at,
    prompt_preview: record.prompt_preview,
    redaction_hits: record.redaction_hits,
    task_id: record.envelope.task_id,
    thread_id: record.envelope.thread_id,
  }));
}

function approvalsHtml(records: Array<Record<string, unknown>>): string {
  if (!records.length) return '<p class="muted">No approvals held for review.</p>';
  return `<div class="stack">${records.map((record) => `<article class="card"><div class="row"><h2>${escapeHtml(record.id)}</h2><span class="badge">HELD FOR REVIEW</span></div><p class="message untrusted"><span class="badge untrusted">redacted preview</span> ${escapeHtml(record.prompt_preview)}</p><dl class="meta"><dt>Agent</dt><dd>${escapeHtml(record.agent)}</dd><dt>Task</dt><dd>${escapeHtml(record.task_id)}</dd><dt>Voyage</dt><dd>${escapeHtml(record.thread_id)}</dd><dt>Created</dt><dd>${escapeHtml(record.created_at)}</dd></dl><div class="actions"><button class="stamp" data-action="/api/approvals/${encodeURIComponent(String(record.id))}/approve">APPROVED</button><button class="stamp deny" data-action="/api/approvals/${encodeURIComponent(String(record.id))}/deny">DENIED</button></div></article>`).join("")}</div>`;
}

function runsHtml(records: Array<Record<string, unknown>>): string {
  const killAll = records.length ? '<button class="danger" data-action="/api/runs/kill-all">Kill all</button>' : "";
  if (!records.length) return '<p class="muted">No crew under sail.</p>';
  return `${killAll}<div class="stack route">${records.map((record) => `<article class="card"><div class="row"><h2>${escapeHtml(record.agent)}</h2><button class="danger" data-action="/api/runs/${encodeURIComponent(String(record.run_id))}/kill">Kill</button></div><dl class="meta"><dt>Run</dt><dd>${escapeHtml(record.run_id)}</dd><dt>Task</dt><dd>${escapeHtml(record.task_id)}</dd><dt>Voyage</dt><dd>${escapeHtml(record.thread_id)}</dd><dt>Started</dt><dd>${escapeHtml(record.started_at)}</dd><dt>PID</dt><dd>${escapeHtml(record.pid)}</dd></dl></article>`).join("")}</div>`;
}

function threadsHtml(records: Array<{ id: string; messages: number; last_ts?: string }>): string {
  if (!records.length) return '<p class="muted">No voyages yet.</p>';
  return `<div class="stack voyage-list">${records.map((record) => `<a class="card voyage-entry" href="/threads/${encodeURIComponent(record.id)}"><strong>Voyage ${escapeHtml(record.id)}</strong><span class="muted"> · ${record.messages} chart entries · ${escapeHtml(record.last_ts ?? "unknown")}</span></a>`).join("")}</div>`;
}

function threadHtml(id: string, messages: Array<Record<string, unknown>>): string {
  if (!messages.length) return '<p class="muted">This voyage has no chart entries.</p>';
  const outbound = messages.find((message) => message.kind === "outbound_task");
  const destination = outbound?.to ?? messages[0]?.to ?? id;
  return `<div class="stack route">${messages.map((message) => {
    const untrusted = message.untrusted === true;
    const sender = String(message.from ?? "?");
    return `<article class="route-node"><div class="node-marker" title="Sender">${escapeHtml(sender)}</div><div class="card"><div class="row"><strong>${escapeHtml(message.from)} → ${escapeHtml(message.to)}</strong>${untrusted ? '<span class="badge untrusted">untrusted agent output</span>' : ""}</div><p class="muted mono">${escapeHtml(message.ts)} · ${escapeHtml(message.kind)} · task ${escapeHtml(message.task_id)}</p><div class="message${untrusted ? " untrusted" : ""}">${escapeHtml(message.text)}</div></div></article>`;
  }).join("")}<div class="destination"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M10 10 38 38M38 10 10 38"/></svg><span>X marks the spot · ${escapeHtml(destination)}</span></div></div>`;
}

async function auditData(hub: Hub): Promise<{ verification: unknown; records: unknown[] }> {
  let content = "";
  try {
    content = await readFile(hub.audit.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const records = content.split("\n").filter(Boolean).slice(-100).map((line) => JSON.parse(line));
  return { verification: await verifyAudit(hub.audit.path), records };
}

function auditHtml(data: { verification: Record<string, unknown>; records: Array<Record<string, unknown>> }): string {
  const valid = data.verification.valid === true;
  return `<article class="card"><div class="row"><h2>Hash-chain seal</h2><span class="badge">${valid ? "VALID" : "INVALID"}</span></div><pre>${escapeHtml(JSON.stringify(data.verification, null, 2))}</pre></article><div class="stack">${data.records.map((record) => `<article class="card"><div class="row"><strong>#${escapeHtml(record.seq)} ${escapeHtml(record.event)}</strong><span class="${record.ok ? "" : "danger"}">${record.ok ? "ok" : "failed"}</span></div><dl class="meta mono"><dt>Time</dt><dd>${escapeHtml(record.ts)}</dd><dt>Agent</dt><dd>${escapeHtml(record.agent)}</dd><dt>Task</dt><dd>${escapeHtml(record.task_id)}</dd><dt>Voyage</dt><dd>${escapeHtml(record.thread_id)}</dd><dt>Preview</dt><dd class="message untrusted">${escapeHtml(record.prompt_preview)}</dd></dl></article>`).join("")}</div>`;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let result = "";
  for await (const chunk of request) {
    result += chunk.toString("utf8");
    if (Buffer.byteLength(result) > 16_384) throw new Error("Request body is too large");
  }
  return result;
}

function validOrigin(request: IncomingMessage, hostHeader: string): boolean {
  const expected = `http://${hostHeader}`;
  if (request.headers.origin !== expected) return false;
  if (!request.headers.referer) return true;
  try {
    return new URL(request.headers.referer).origin === expected;
  } catch {
    return false;
  }
}

async function csrfFrom(request: IncomingMessage): Promise<string> {
  const header = request.headers["x-ttb-csrf"];
  if (typeof header === "string") return header;
  if (!String(request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) return "";
  return new URLSearchParams(await readBody(request)).get("csrf") ?? "";
}

async function configuredToken(home: string): Promise<{ token: string; fromFile: boolean }> {
  const filename = path.join(home, "ui-token");
  try {
    const details = await lstat(filename);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("TTB UI token must be a regular file");
    if ((details.mode & 0o777) !== 0o600) throw new Error("TTB UI token file must have mode 0600");
    const token = (await readFile(filename, "utf8")).trim();
    if (Buffer.byteLength(token) < 32) throw new Error("TTB UI token must contain at least 32 bytes");
    return { token, fromFile: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { token: randomBytes(32).toString("base64url"), fromFile: false };
  }
}

async function staticResponse(pathname: string): Promise<{ body: string | Buffer; type: string } | undefined> {
  if (pathname === "/app.css") return { body: APP_CSS, type: "text/css; charset=utf-8" };
  if (pathname === "/app.js") return { body: APP_JS, type: "text/javascript; charset=utf-8" };
  if (pathname === "/sw.js") return { body: SERVICE_WORKER, type: "text/javascript; charset=utf-8" };
  if (pathname === "/manifest.webmanifest") return { body: MANIFEST, type: "application/manifest+json; charset=utf-8" };
  if (pathname === "/icon.svg") return { body: ICON_SVG, type: "image/svg+xml; charset=utf-8" };
  const font = pathname.startsWith("/fonts/") ? pathname.slice("/fonts/".length) : "";
  if (FONT_FILES.has(font)) return { body: await fontBody(font), type: "font/woff2" };
  return undefined;
}

async function handleAction(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  match: RegExpExecArray,
  hub: Hub,
): Promise<void> {
  try {
    if (match[1]) {
      const resolved = await resolveApproval(hub, match[1], match[2] as "approve" | "deny");
      sendJson(response, resolved.exitCode === 0 ? 200 : 502, {
        ok: resolved.exitCode === 0,
        exit_code: resolved.exitCode,
        data: resolved.data,
      });
      return;
    }
    const records = await hub.runs.list();
    const selected = match[3] === "kill-all"
      ? records
      : records.filter((record) => `${record.run_id}/kill` === match[3]);
    if (match[3] !== "kill-all" && !selected.length) {
      sendJson(response, 404, { ok: false, error: "Run not found" });
      return;
    }
    const results = [];
    for (const record of selected) results.push(await killRun(record, hub.runs, hub.audit));
    const ok = results.every((result) => result.stopped);
    sendJson(response, ok ? 200 : 409, { ok, exit_code: ok ? 0 : 4, data: results });
  } catch (error) {
    sendJson(response, 409, { ok: false, error: (error as Error).message, path: pathname });
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  hub: Hub,
  token: string,
  csrf: string,
  port: number,
): Promise<void> {
  const hostHeader = request.headers.host ?? "";
  if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) {
    send(response, 421, "Misdirected Request\n", "text/plain; charset=utf-8");
    return;
  }
  const url = new URL(request.url ?? "/", `http://${hostHeader}`);
  const staticAsset = await staticResponse(url.pathname);
  if (staticAsset && PUBLIC_PATHS.has(url.pathname)) {
    if (request.method !== "GET") {
      send(response, 405, "Method Not Allowed\n", "text/plain; charset=utf-8", { Allow: "GET" });
      return;
    }
    send(response, 200, staticAsset.body, staticAsset.type, {}, false);
    return;
  }

  const suppliedToken = url.searchParams.get("token");
  if (suppliedToken !== null) {
    if (!safeEqual(suppliedToken, token)) {
      send(response, 401, "Unauthorized\n", "text/plain; charset=utf-8");
      return;
    }
    send(response, 303, "Redirecting\n", "text/plain; charset=utf-8", {
      Location: url.pathname || "/",
      "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`,
    });
    return;
  }

  const cookie = parseCookies(request.headers.cookie).get(COOKIE_NAME) ?? "";
  if (!safeEqual(cookie, token)) {
    send(response, 401, "Unauthorized\n", "text/plain; charset=utf-8");
    return;
  }

  if (staticAsset && STATIC_PATHS.has(url.pathname)) {
    if (request.method !== "GET") {
      send(response, 405, "Method Not Allowed\n", "text/plain; charset=utf-8", { Allow: "GET" });
      return;
    }
    send(response, 200, staticAsset.body, staticAsset.type, {}, false);
    return;
  }

  const action = ACTION_ROUTE.exec(url.pathname);
  if (action) {
    if (request.method !== "POST") {
      send(response, 405, "Method Not Allowed\n", "text/plain; charset=utf-8", { Allow: "POST" });
      return;
    }
    if (!validOrigin(request, hostHeader) || !safeEqual(await csrfFrom(request), csrf)) {
      sendJson(response, 403, { ok: false, error: "CSRF validation failed" });
      return;
    }
    await handleAction(request, response, url.pathname, action, hub);
    return;
  }

  if (request.method !== "GET") {
    send(response, 405, "Method Not Allowed\n", "text/plain; charset=utf-8", { Allow: "GET" });
    return;
  }

  if (url.pathname === "/") {
    send(response, 302, "Redirecting\n", "text/plain; charset=utf-8", { Location: "/agents" });
    return;
  }
  if (url.pathname === "/agents" || url.pathname === "/api/agents") {
    const data = await agentsData(hub);
    if (url.pathname.startsWith("/api/")) sendJson(response, 200, { agents: data });
    else send(response, 200, page("Crew", "The available crew and their current sailing status.", agentsHtml(data), csrf), "text/html; charset=utf-8");
    return;
  }
  if (url.pathname === "/threads" || url.pathname === "/api/threads") {
    const data = await listThreads(hub.threads);
    if (url.pathname.startsWith("/api/")) sendJson(response, 200, { threads: data });
    else send(response, 200, page("Voyages", "Charted routes between the crew.", threadsHtml(data), csrf, true), "text/html; charset=utf-8");
    return;
  }
  const threadMatch = /^\/(api\/)?threads\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(url.pathname);
  if (threadMatch) {
    assertSafeSlug(threadMatch[2], "thread id");
    const messages = await readThread(hub.threads, threadMatch[2]) as Array<Record<string, unknown>>;
    const safeMessages = redactThreadMessagesForDisplay(hub.redactor, messages);
    if (threadMatch[1]) sendJson(response, 200, { id: threadMatch[2], messages: safeMessages });
    else send(response, 200, page(`Voyage ${threadMatch[2]}`, "Follow the chart, entry by entry.", threadHtml(threadMatch[2], safeMessages), csrf, true), "text/html; charset=utf-8");
    return;
  }
  if (url.pathname === "/approvals" || url.pathname === "/api/approvals") {
    const data = await approvalsData(hub) as Array<Record<string, unknown>>;
    if (url.pathname.startsWith("/api/")) sendJson(response, 200, { approvals: data });
    else send(response, 200, page("Approvals", "Work held for review. Stamp each one approved or denied.", approvalsHtml(data), csrf, true), "text/html; charset=utf-8");
    return;
  }
  if (url.pathname === "/runs" || url.pathname === "/api/runs") {
    const data = await hub.runs.list() as unknown as Array<Record<string, unknown>>;
    if (url.pathname.startsWith("/api/")) sendJson(response, 200, { runs: data });
    else send(response, 200, page("Live runs", "Runs currently under sail.", runsHtml(data), csrf, true), "text/html; charset=utf-8");
    return;
  }
  if (url.pathname === "/audit" || url.pathname === "/api/audit") {
    const data = await auditData(hub) as { verification: Record<string, unknown>; records: Array<Record<string, unknown>> };
    if (url.pathname.startsWith("/api/")) sendJson(response, 200, data);
    else send(response, 200, page("Logbook", "Recent redacted entries and the current chain seal.", auditHtml(data), csrf, true), "text/html; charset=utf-8");
    return;
  }
  send(response, 404, page("Not found", "That chart route does not exist.", "", csrf), "text/html; charset=utf-8");
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7717;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("UI port must be an integer from 0 to 65535");
  const hub = options.hub ?? await createHub();
  const env = options.env ?? process.env;
  const session = await configuredToken(hub.home);
  const loopback = host === "127.0.0.1" || host === "localhost";
  if (!loopback && !(env.TTB_UI_ALLOW_REMOTE === "1" && session.fromFile)) {
    throw new Error("Non-loopback UI hosts require TTB_UI_ALLOW_REMOTE=1 and a configured $TTB_HOME/ui-token; remote access is not supported in P1");
  }
  const csrf = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    void route(request, response, hub, session.token, csrf, (server.address() as { port: number }).port).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: (error as Error).message });
      else response.destroy(error as Error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("UI server did not bind a TCP port");
  const actualPort = address.port;
  let closed = false;
  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/?token=${encodeURIComponent(session.token)}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await hub.muse.stop();
    },
  };
}
