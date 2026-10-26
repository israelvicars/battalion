#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(`${JSON.stringify({
    loggedIn: process.env.MOCK_CLAUDE_LOGGED_OUT !== "1",
    authMethod: process.env.MOCK_CLAUDE_LOGGED_OUT === "1" ? "none" : "subscription",
  })}\n`);
  process.exit(0);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString("utf8");
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const metered = prompt.includes("METERED");
emit({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  session_id: "fixture-session",
  tools: ["Read", "Grep", "Glob"],
  model: "fixture",
  permissionMode: "dontAsk",
  apiKeySource: metered ? "ANTHROPIC_API_KEY" : "none",
  claude_code_version: "2.1.310",
});

const pidMatch = /PIDFILE=([^\s]+)/.exec(prompt);
if (metered || prompt.includes("HANG")) {
  if (pidMatch) writeFileSync(pidMatch[1], String(process.pid));
  process.on("SIGTERM", () => {});
  spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  setInterval(() => {}, 1_000);
} else if (prompt.includes("CAPTURE")) {
  const captured = JSON.stringify({ args, stdin: prompt, env: process.env, cwd: process.cwd() });
  emit({ type: "assistant", message: { content: [{ type: "text", text: captured }], usage: { input_tokens: 2, output_tokens: 3 } } });
  emit({ type: "result", subtype: "success", is_error: false, result: captured, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } });
} else if (prompt.includes("PERMISSION")) {
  emit({ type: "system", subtype: "permission_denied", tool_name: "Read", decision_reason_type: "outside_scope", message: "Sibling read denied" });
  emit({ type: "result", subtype: "success", is_error: false, result: "Denied as expected", duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
} else {
  emit({ type: "assistant", message: { content: [{ type: "thinking", thinking: "fixture" }, { type: "text", text: "CLAUDE_OK" }], usage: { input_tokens: 1, output_tokens: 1 } } });
  emit({ type: "result", subtype: "success", is_error: false, result: "CLAUDE_OK", duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
}
