#!/usr/bin/env node
import { spawn } from "node:child_process";

if (process.argv[2] === "login" && process.argv[3] === "status") {
  process.stdout.write("Logged in\n");
  process.exit(0);
}

for await (const _chunk of process.stdin) {
  // Consume stdin before hanging, like `codex exec` does.
}
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "hang" })}\n`);
process.on("SIGTERM", () => {});
spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
  stdio: "ignore",
});
setInterval(() => {}, 1_000);
