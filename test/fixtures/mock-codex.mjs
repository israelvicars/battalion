#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "login" && args[1] === "status") {
  process.stdout.write(`${process.env.MOCK_LOGIN_OUTPUT ?? "Logged in"}\n`);
  process.exit(0);
}

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk.toString("utf8");
if (process.env.MOCK_ARGS_FILE) {
  writeFileSync(process.env.MOCK_ARGS_FILE, JSON.stringify({ args, stdin }));
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const mode = process.env.MOCK_CODEX_MODE ?? "success";
emit({ type: "thread.started", thread_id: "mock-thread" });

if (mode === "capture") {
  emit({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify({ args, stdin, env: process.env }) },
  });
  process.exit(0);
}

if (mode === "secrets") {
  const github = `ghp_${"FAKEFIXTURE".repeat(4)}`;
  const privateKey = [
    "-----BEGIN PRIVATE KEY-----",
    "RkFLRS1OT1QtQS1SRUFM LVByaXZhdGVLZXlGaXh0dXJl".replace(" ", ""),
    "-----END PRIVATE KEY-----",
  ].join("\n");
  emit({
    type: "item.completed",
    item: { type: "agent_message", text: `token=${github}\n${privateKey}` },
  });
  process.exit(0);
}

if (mode === "failure") {
  const github = `ghp_${"FAILFIXTURE".repeat(4)}`;
  process.stderr.write("ERROR codex_models_manager::cache: failed to load models cache: benign fixture warning\n");
  process.stderr.write(`request failed with token ${github} ${"X".repeat(600)}\n`);
  process.exit(1);
}

if (mode === "verified-sample") {
  process.stderr.write("ERROR codex_models_manager::cache: failed to load models cache: benign fixture warning\n");
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "OK" } });
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 14889,
      cached_input_tokens: 9856,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    },
  });
  process.exit(0);
}

if (mode === "hang") {
  if (process.env.MOCK_PID_FILE) writeFileSync(process.env.MOCK_PID_FILE, String(process.pid));
  process.on("SIGTERM", () => {});
  spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  setInterval(() => {}, 1_000);
} else if (stdin.includes("DEMO:")) {
  const answer = "src/ledger.js: total() uses sum - item.amount, so every total is negated. Change it to sum + item.amount. No other issues in scope.";
  emit({ type: "item.completed", item: { type: "agent_message", text: answer } });
} else {
  emit({ type: "item.completed", item: { type: "agent_message", text: "OK" } });
}
