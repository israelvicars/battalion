import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveTtbHome } from "../src/core/config.ts";

const fixtures = {
  codex: path.resolve("test/fixtures/mock-codex.mjs"),
  cursor: path.resolve("test/fixtures/mock-cursor.mjs"),
  claude: path.resolve("test/fixtures/mock-claude.mjs"),
};

function run(binary: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, "agents", "--json"], { env, cwd: path.resolve(".") });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("BATTALION_HOME is preferred while TTB_HOME remains supported", () => {
  const beforeBattalion = process.env.BATTALION_HOME;
  const beforeTtb = process.env.TTB_HOME;
  try {
    process.env.BATTALION_HOME = "/tmp/battalion-home";
    process.env.TTB_HOME = "/tmp/legacy-home";
    assert.equal(resolveTtbHome(), "/tmp/battalion-home");
  } finally {
    if (beforeBattalion === undefined) delete process.env.BATTALION_HOME;
    else process.env.BATTALION_HOME = beforeBattalion;
    if (beforeTtb === undefined) delete process.env.TTB_HOME;
    else process.env.TTB_HOME = beforeTtb;
  }
});

test("battalion and ttb aliases both execute the JSON agents command", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "battalion-surface-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    TTB_HOME: path.join(root, "home"),
    TTB_MUSE_MAILBOX: path.join(root, "mailbox"),
    TTB_CODEX_BIN: fixtures.codex,
    TTB_CURSOR_BIN: fixtures.cursor,
    TTB_CLAUDE_BIN: fixtures.claude,
  };
  for (const binary of [path.resolve("bin/battalion"), path.resolve("bin/ttb")]) {
    const result = await run(binary, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
});
