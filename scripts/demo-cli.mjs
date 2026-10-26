#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const real = process.argv.includes("--real");
const keep = process.argv.includes("--keep");
const root = await mkdtemp(path.join(tmpdir(), "battalion-demo-"));
const home = path.join(root, "home");
const harbor = path.join(root, "harbor");
await mkdir(path.join(harbor, "src"), { recursive: true });
await writeFile(path.join(harbor, "src", "ledger.js"), "export function total(items) { return items.reduce((sum, item) => sum - item.amount, 0); }\n");

const env = { ...process.env, TTB_HOME: home, TTB_SCOPE_ROOTS: harbor };
delete env.TTB_CODEX_PLAN_ENDS;
if (real) {
  delete env.TTB_CODEX_BIN;
  delete env.TTB_CURSOR_BIN;
} else {
  env.TTB_CODEX_BIN = path.join(repo, "test/fixtures/mock-codex.mjs");
  env.TTB_CURSOR_BIN = path.join(repo, "test/fixtures/mock-cursor.mjs");
  env.TTB_CLAUDE_BIN = path.join(repo, "test/fixtures/mock-claude.mjs");
  env.TTB_MUSE_MAILBOX = path.join(root, "mailbox");
  env.HOME = root;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, "bin/battalion"), ...args], { cwd: repo, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function step(label, args, expected = 0) {
  const result = await run([...args, "--json"]);
  process.stdout.write(`\n== ${label} ==\n${result.stdout.trim()}\n`);
  if (result.code !== expected) throw new Error(`${label} failed (${result.code}): ${result.stderr}`);
  try { return JSON.parse(result.stdout); } catch { return {}; }
}

try {
  await step("crew manifest", ["agents"]);
  const fanout = await step("fanout", ["fanout", "@codex", "@cursor", "DEMO: find the toy ledger bug", "--scope", harbor, "--thread", "demo-voyage", "--from", "captain"]);
  const approval = fanout.data?.answers?.find((answer) => answer.agent === "cursor")?.approval?.id;
  if (!approval) throw new Error("cursor approval id was not returned by fanout");
  await step("approvals", ["approvals"]);
  await step("approve cursor", ["approve", approval]);
  await step("voyage", ["thread", "demo-voyage"]);
  await step("record comparison", ["compare", "demo-voyage", "--agree", "Both spotted the subtraction bug.", "--disagree", "Cursor proposes a patch; Codex only reports it.", "--changed-decision", "no", "--from", "captain"]);
  await step("tally", ["tally"]);
  await step("audit seal", ["audit", "verify"]);
  process.stdout.write(`\nDemo complete. Home: ${home}\n`);
} catch (error) {
  process.stderr.write(`\nDemo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (!keep) await rm(root, { recursive: true, force: true });
  else process.stdout.write(`Kept demo directory: ${root}\n`);
}
