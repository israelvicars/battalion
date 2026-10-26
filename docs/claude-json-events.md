# Claude Code `stream-json` events

Status: **verified shape** from Claude Code 2.1.310 on this Mac. The Milestone
4 build did not run the real binary; the supplied verified sample shape is
covered by `test/fixtures/mock-claude.mjs`.

Handled records:

- `system/init`: `cwd`, `session_id`, `tools`, `model`, `permissionMode`,
  `apiKeySource`, and `claude_code_version`. `apiKeySource` must be exactly
  `"none"`; any other value immediately terminates the process group with
  `metered_auth_refused`.
- `assistant`: `message.content` parts of type `text`, `thinking`, or
  `tool_use`, plus token usage. Text becomes `text`, thinking is ignored, and
  tool use becomes `tool_call`.
- `user`: tool-result content becomes `tool_result`.
- `system/permission_denied`: becomes a visible normalized `error` with reason
  `permission_denied` and the tool/message detail.
- `result`: `subtype`, `is_error`, final `result`, `duration_ms`,
  `total_cost_usd`, and token/cache usage. Cost is informational usage only.

Unknown metadata records are ignored with a type-only diagnostic. Non-JSON
lines are normalized as text. All released strings are redacted.

The restricted invocation is:

```text
claude -p --output-format stream-json --verbose --restricted --strict-mcp-config --tools Read,Grep,Glob --permission-mode dontAsk --permission-prompts none --no-session-persistence [--add-dir <extra-scope>...] [--model <model>]
```

The prompt is sent on stdin. The verified real test showed that a Read call to
a sibling directory produced `system/permission_denied` and did not return the
file content. A real ttb-hub smoke test remains pending login.
