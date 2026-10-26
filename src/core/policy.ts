import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type HubPolicy = {
  scope_roots?: string[];
  auto_approve_inbound?: string[];
  adapter_env_allowlist?: Record<string, string[]>;
};

const POLICY_FIELDS = new Set(["scope_roots", "auto_approve_inbound", "adapter_env_allowlist"]);

function assertAbsoluteRoots(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((item) => typeof item !== "string" || !path.isAbsolute(item) || /[\r\n]/.test(item))) {
    throw new Error(`${source} must contain one or more absolute paths`);
  }
  return [...new Set((value as string[]).map((item) => path.resolve(item)))];
}

export async function loadHubPolicy(ttbHome: string): Promise<HubPolicy> {
  const filename = path.join(path.resolve(ttbHome), "policy.json");
  let text: string;
  try {
    text = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error("policy.json exceeds 64 KiB");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("policy.json must contain an object");
  }
  const record = parsed as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!POLICY_FIELDS.has(field)) throw new Error(`policy.json has unknown field ${field}`);
  }
  const policy: HubPolicy = {};
  if (record.scope_roots !== undefined) {
    policy.scope_roots = assertAbsoluteRoots(record.scope_roots, "policy.json scope_roots");
  }
  if (record.auto_approve_inbound !== undefined) {
    if (!Array.isArray(record.auto_approve_inbound) ||
        record.auto_approve_inbound.some((item) => typeof item !== "string")) {
      throw new Error("policy.json auto_approve_inbound must be an array of agent ids");
    }
    policy.auto_approve_inbound = [...new Set(record.auto_approve_inbound as string[])];
  }
  if (record.adapter_env_allowlist !== undefined) {
    if (!record.adapter_env_allowlist || typeof record.adapter_env_allowlist !== "object" ||
        Array.isArray(record.adapter_env_allowlist)) {
      throw new Error("policy.json adapter_env_allowlist must be an object of agent id to environment-variable names");
    }
    policy.adapter_env_allowlist = {};
    for (const [agent, names] of Object.entries(record.adapter_env_allowlist as Record<string, unknown>)) {
      if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name))) {
        throw new Error(`policy.json adapter_env_allowlist.${agent} must be an array of environment-variable names`);
      }
      policy.adapter_env_allowlist[agent] = [...new Set(names as string[])];
    }
  }
  return policy;
}

function inside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function resolvedPath(candidate: string, label: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`${label} could not be resolved (${code}): ${candidate}`);
  }
}

export async function peerScopeRoots(
  ttbHome: string,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): Promise<string[]> {
  const defaultProjects = path.resolve(userHome, "Projects");
  // Default vault root is ~/Agents; TTB_VAULT can narrow it to one vault folder.
  const defaultVault = path.resolve(userHome, "Agents");
  const resolvedDefaults = await Promise.all([
    resolvedPath(defaultProjects, "default Projects root"),
    resolvedPath(defaultVault, "default vault root"),
  ]);
  const configuredVault = env.TTB_VAULT ?? defaultVault;
  if (!path.isAbsolute(configuredVault)) throw new Error("TTB_VAULT must be an absolute path");
  const resolvedVault = await resolvedPath(configuredVault, "TTB_VAULT");
  if (!resolvedDefaults.some((root) => inside(resolvedVault, root))) {
    throw new Error(`TTB_VAULT may only narrow the default roots: ${configuredVault}`);
  }

  let roots: string[];
  if (env.TTB_SCOPE_ROOTS !== undefined) {
    roots = assertAbsoluteRoots(
      env.TTB_SCOPE_ROOTS.split(path.delimiter).filter(Boolean),
      "TTB_SCOPE_ROOTS",
    );
  } else {
    const policy = await loadHubPolicy(ttbHome);
    roots = policy.scope_roots ?? [
      defaultProjects,
      resolvedVault,
    ].map((item) => path.resolve(item));
  }
  const resolvedRoots = await Promise.all(roots.map((root) => resolvedPath(root, "peer scope root")));
  for (const [index, root] of resolvedRoots.entries()) {
    if (!resolvedDefaults.some((allowed) => inside(root, allowed))) {
      throw new Error(`peer scope root may only narrow the default roots: ${roots[index]}`);
    }
  }
  return [...new Set(resolvedRoots)];
}

export async function adapterEnvAdditions(
  ttbHome: string,
  agent: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string | undefined>> {
  const policy = await loadHubPolicy(ttbHome);
  return Object.fromEntries((policy.adapter_env_allowlist?.[agent] ?? []).map((name) => [name, env[name]]));
}

export async function autoApproveInbound(ttbHome: string, agent: string): Promise<boolean> {
  const policy = await loadHubPolicy(ttbHome);
  return policy.auto_approve_inbound?.includes(agent) ?? false;
}
