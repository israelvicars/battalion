#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "status") {
  process.stdout.write(`${process.env.MOCK_CURSOR_STATUS ?? "Logged in"}\n`);
  process.exit(0);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString("utf8");
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "system", subtype: "init" });

const pidMatch = /PIDFILE=([^\s]+)/.exec(prompt);
if (prompt.includes("HANG")) {
  if (pidMatch) writeFileSync(pidMatch[1], String(process.pid));
  process.on("SIGTERM", () => {});
  spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  setInterval(() => {}, 1_000);
} else if (prompt.includes("CAPTURE")) {
  const captured = JSON.stringify({ args, stdin: prompt, env: process.env, cwd: process.cwd() });
  emit({ type: "assistant", message: { content: [{ type: "text", text: captured }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: captured, duration_ms: 1 });
} else if (prompt.includes("THINKING")) {
  for (let index = 0; index < 8; index += 1) {
    emit({ type: "thinking", subtype: "delta", text: `private thought ${index}` });
  }
  emit({ type: "thinking", subtype: "completed" });
  emit({ type: "mystery", message: { content: [{ type: "text", text: "unknown payload" }] } });
  emit({ type: "mystery", message: { content: [{ type: "text", text: "unknown payload again" }] } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "I'll scan src/ before making a change. Focusing on the relevant files." }] } });
  emit({ type: "tool_call", subtype: "started", name: "read_file" });
  emit({ type: "tool_call", subtype: "completed", name: "read_file" });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Final answer from Cursor." }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "I'll scan src/ before making a change. Focusing on the relevant files. Final answer from Cursor.", duration_ms: 1 });
} else if (prompt.includes("DEMO:")) {
  writeFileSync(path.join(process.cwd(), "src", "ledger.js"), "export function total(items) { return items.reduce((sum, item) => sum + item.amount, 0); }\n");
  emit({ type: "tool_call", subtype: "started", name: "write_file" });
  emit({ type: "tool_call", subtype: "completed", name: "write_file" });
  const answer = "Found it: total() in src/ledger.js subtracts each amount (sum - item.amount), so totals come out negative. Fix: use sum + item.amount. I applied that one-line change in the scratch copy.";
  emit({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: answer, duration_ms: 1 });
} else {
  const token = `ghp_${"CURSORFIXTURE".repeat(4)}`;
  writeFileSync(path.join(process.cwd(), "cursor-created.txt"), `created only in scratch ${token}\n`);
  emit({ type: "tool_call", subtype: "started", name: "write_file" });
  emit({ type: "tool_call", subtype: "completed", name: "write_file" });
  emit({ type: "assistant", message: { content: [{ type: "text", text: `Cursor completed ${token}` }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: `Cursor completed ${token}`, duration_ms: 1 });
}
