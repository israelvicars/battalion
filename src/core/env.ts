const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "TMPDIR",
  "USER",
  "CODEX_HOME",
] as const;

export function buildChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  additions: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (parent[name] !== undefined) child[name] = parent[name];
  }
  for (const [name, value] of Object.entries(additions)) {
    if (value !== undefined) child[name] = value;
  }
  return child;
}

export { CHILD_ENV_ALLOWLIST };
