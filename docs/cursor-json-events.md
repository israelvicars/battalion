# Cursor `stream-json` event assumptions

Status: **UNVERIFIED against a logged-in real Cursor CLI**. The adapter was
implemented from the documented shape supplied for `cursor-agent 2026.10.22`
and exercised only with `test/fixtures/mock-cursor.mjs`.

The adapter accepts one JSON object per stdout line and tolerates malformed or
unknown lines. The assumed records are:

- `{ "type": "system", "subtype": "init", ... }` — metadata only.
- `{ "type": "user", "message": { "content": [...] } }` — text content is
  normalized as `text` when present.
- `{ "type": "assistant", "message": { "content": [
  { "type": "text", "text": "..." } ] } }` — each text part becomes `text`.
- `{ "type": "tool_call", "subtype": "started"|"completed", ... }` — maps
  to `tool_call` or `tool_result`.
- `{ "type": "result", "subtype": "...", "is_error": false,
  "result": "...", "duration_ms": 1, "usage": { ... } }` — supplies the
  final result, optional usage, and an error event when `is_error` is true.

Non-JSON lines become text. Unknown JSON records with recognizable message
text become text; metadata-only records are ignored and only their type is
logged. Every normalized event and final result is redacted before release.

The invocation is:

```text
cursor-agent -p --output-format stream-json --sandbox enabled --trust --workspace <throwaway-copy> [--mode ask] [--model <model>]
```

The prompt is sent on stdin. The real stream shape and whether Cursor's
sandbox prevents reads outside `--workspace` remain unverified pending login.
