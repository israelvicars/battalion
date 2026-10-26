#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHub } from "../src/cli/main.ts";
import { startUiServer } from "../src/web/server.ts";

// Playwright looks for browsers under $HOME; pin the real cache before HOME points at the temp demo dir.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.HOME) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.platform === "darwin"
    ? path.join(process.env.HOME, "Library/Caches/ms-playwright")
    : path.join(process.env.HOME, ".cache/ms-playwright");
}
const repo = path.resolve(new URL("..", import.meta.url).pathname);
const root = await mkdtemp(path.join(tmpdir(), "battalion-ui-demo-"));
const home = path.join(root, "home");
const harbor = path.join(root, "harbor");
await mkdir(path.join(harbor, "src"), { recursive: true });
await writeFile(path.join(harbor, "src", "ledger.js"), "export function total(items) { return items.reduce((sum, item) => sum - item.amount, 0); }\n");
const env = { ...process.env, HOME: root, TTB_HOME: home, TTB_SCOPE_ROOTS: harbor, TTB_MUSE_MAILBOX: path.join(root, "mailbox"), TTB_CODEX_BIN: path.join(repo, "test/fixtures/mock-codex.mjs"), TTB_CURSOR_BIN: path.join(repo, "test/fixtures/mock-cursor.mjs"), TTB_CLAUDE_BIN: path.join(repo, "test/fixtures/mock-claude.mjs") };
delete env.TTB_CODEX_PLAN_ENDS;
delete process.env.TTB_CODEX_PLAN_ENDS;
Object.assign(process.env, env);
const screenshots = path.join(repo, "docs/screenshots");
await mkdir(screenshots, { recursive: true });

function runCli(args) { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [path.join(repo, "bin/battalion"), ...args, "--json"], { cwd: repo, env }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.once("error", reject); child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr })); }); }
async function jsonCli(args) { const result = await runCli(args); if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.stderr}`); return JSON.parse(result.stdout); }
async function screenshotChrome(url, filename) { const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; return new Promise((resolve, reject) => { const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1280,900", `--screenshot=${path.join(screenshots, filename)}`, url], { stdio: "ignore" }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Chrome exited ${code}`))); }); }
function csrf(html) { const match = /<meta name="ttb-csrf" content="([^"]+)">/.exec(html); if (!match) throw new Error("CSRF token missing"); return match[1]; }
async function approveOverHttp(ui, tokenUrl, approvalId) { const exchanged = await fetch(tokenUrl, { redirect: "manual" }); const cookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0]; if (!cookie) throw new Error("session cookie missing"); const base = new URL(tokenUrl); const page = await fetch(new URL("/approvals", base), { headers: { cookie } }); const token = csrf(await page.text()); const response = await fetch(new URL(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, base), { method: "POST", headers: { cookie, origin: base.origin, "x-ttb-csrf": token } }); if (!response.ok) throw new Error(`approval failed: ${response.status}`); }

let ui;
try {
  const fanout = await jsonCli(["fanout", "@codex", "@cursor", "DEMO: find the toy ledger bug", "--scope", harbor, "--thread", "demo-voyage", "--from", "captain"]);
  const approval = fanout.data?.answers?.find((answer) => answer.agent === "cursor")?.approval?.id;
  if (!approval) throw new Error("cursor approval id missing");
  const hub = await createHub();
  ui = await startUiServer({ hub, port: 0, host: "127.0.0.1", env });
  const baseUrl = ui.url.split("?")[0].replace(/\/$/, "");
  const sessionUrl = (pathname) => `${baseUrl}${pathname}?token=${encodeURIComponent(new URL(ui.url).searchParams.get("token"))}`;
  let browserPath = "global Playwright";
  let playwright;
  try { const globalRoot = (await new Promise((resolve, reject) => { const child = spawn("npm", ["root", "-g"]); let out = ""; child.stdout.on("data", (chunk) => { out += chunk; }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve(out.trim()) : reject(new Error("npm root failed"))); })).toString(); playwright = await import(pathToFileURL(path.join(globalRoot, "playwright/index.mjs")).href); } catch { browserPath = "Google Chrome fallback"; }
  let browser;
  if (playwright) {
    try { browser = await playwright.chromium.launch({ headless: true }); } catch (error) { browserPath = "Google Chrome fallback"; process.stdout.write(`Playwright launch failed (${error instanceof Error ? error.message.split("\n")[0] : error}); using Chrome.\n`); }
  }
  process.stdout.write(`Browser path: ${browserPath}\n`);
  if (browser) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(ui.url); await page.screenshot({ path: path.join(screenshots, "01-crew.png") });
    await page.goto(`${baseUrl}/threads/demo-voyage`); await page.screenshot({ path: path.join(screenshots, "02-voyage-pending.png") });
    await page.goto(`${baseUrl}/approvals`); await page.screenshot({ path: path.join(screenshots, "03-approvals.png") });
    await page.getByRole("button", { name: "APPROVED" }).click(); await page.waitForTimeout(2500); await page.goto(`${baseUrl}/threads/demo-voyage`); await page.screenshot({ path: path.join(screenshots, "04-voyage-complete.png") });
    await page.goto(`${baseUrl}/audit`); await page.screenshot({ path: path.join(screenshots, "05-logbook.png") }); await browser.close();
  } else {
    await screenshotChrome(sessionUrl("/agents"), "01-crew.png"); await screenshotChrome(sessionUrl("/threads/demo-voyage"), "02-voyage-pending.png"); await screenshotChrome(sessionUrl("/approvals"), "03-approvals.png"); await approveOverHttp(ui, ui.url, approval); await new Promise((resolve) => setTimeout(resolve, 2500)); await screenshotChrome(sessionUrl("/threads/demo-voyage"), "04-voyage-complete.png"); await screenshotChrome(sessionUrl("/audit"), "05-logbook.png");
  }
  process.stdout.write(`Screenshots written to ${screenshots}\n`);
} finally {
  if (ui) await ui.close();
  await rm(root, { recursive: true, force: true });
}
