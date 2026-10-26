# Codex `--json` event shape

Milestone 1 treats Codex CLI standard output as JSONL: one JSON object per
line. This is an intentionally tolerant boundary because the CLI event format
may evolve. Standard error is captured separately and is exposed only as a
redacted `error` event when the process exits unsuccessfully.

The first four shapes below were **VERIFIED against codex-cli 0.146.0 on
2026-10-24** using the prompt "Reply with the single word OK". The remaining
shapes are tolerant adapter assumptions and still need comparison with real
runs that exercise those paths.

| Status | Codex JSONL record | Normalized event |
| --- | --- | --- |
| Verified | `{"type":"thread.started","thread_id":"<uuid>"}` | Ignored; the adapter has already emitted `started` with its own run ID. |
| Verified | `{"type":"turn.started"}` | Ignored. |
| Verified | `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}` | `text`; agent-message chunks form the final text. |
| Verified | `{"type":"turn.completed","usage":{"input_tokens":14889,"cached_input_tokens":9856,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}` | `cost` with `cost_usd: 0` and the five token counts; usage is also exposed on the adapter and broker results and recorded in the audit line. |
| Assumed | `{"type":"item.started","item":{"type":"command_execution"|"mcp_tool_call"|"web_search", ...}}` | `tool_call` |
| Assumed | `{"type":"item.completed"|"item.updated","item":{"type":"command_execution"|"mcp_tool_call"|"web_search", ...}}` | `tool_result` |
| Assumed | `{"type":"item.*","item":{"type":"file_change","path":"..."}}` | `file_changed` |
| Assumed | `{"type":"turn.failed","error":...}` or `{"type":"error",...}` | `error` |
| Assumed | `{"type":"cost","cost_usd":0,...token counts}` | `cost` |

For an unknown type, a top-level `text`, `message`, or `output` string becomes
a normalized `text` event. A metadata-only unknown record is ignored. In both
cases the adapter logs only the unknown type and disposition—not the raw
record—to avoid creating a secret-bearing diagnostic channel. A non-JSON line
is treated as text.

Every normalized event is recursively redacted before it leaves the adapter.
Process close emits exactly one `finished` event. Timeout and cancellation emit
an `error` (`reason: "timeout"` or `"cancelled"`) before `finished`.

As of Milestone 3, launch arguments use the reviewer-verified custom
`ttb_scope` filesystem permission profile instead of built-in
`--sandbox read-only`. The first scope path is represented by `"."="read"`
under `:workspace_roots`; additional resolved paths are explicit read-only
entries. This changes launch isolation only, not the JSONL event mapping.

Codex may write a benign models-cache warning to stderr even when it exits
successfully. Stderr never creates an error on exit status 0. On a non-zero
exit, lines beginning with
`ERROR codex_models_manager::cache: failed to load models cache:` are removed
before the remaining, redacted stderr becomes the `process_exit` message.
