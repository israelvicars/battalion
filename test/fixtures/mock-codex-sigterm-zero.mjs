#!/usr/bin/env node
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => process.exit(0));
if (process.env.MOCK_READY_FILE) writeFileSync(process.env.MOCK_READY_FILE, "ready");

for await (const _chunk of process.stdin) {
  // Consume stdin before waiting, like `codex exec` does.
}

process.stdout.write(`${JSON.stringify({ type: "text", text: "worker output must be dropped" })}\n`);
setInterval(() => {}, 1_000);
