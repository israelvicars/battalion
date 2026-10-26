import { realpath } from "node:fs/promises";
import path from "node:path";
import type { TaskScope } from "./envelope.ts";

export class ScopeError extends Error {
  rejectedPath?: string;

  constructor(message: string, rejectedPath?: string) {
    super(message);
    this.name = "ScopeError";
    this.rejectedPath = rejectedPath;
  }
}

export type ScopePolicy = {
  systemPaths?: string[];
  userPaths?: string[];
  peerPaths?: string[];
};

export type ResolvedScope = Omit<TaskScope, "paths"> & { paths: string[] };

function pathSegments(candidate: string): string[] {
  return path.resolve(candidate).split(path.sep).filter(Boolean);
}

export function deniedPathKind(candidate: string): string | undefined {
  const normalized = path.resolve(candidate);
  const segments = pathSegments(normalized);
  const basename = path.basename(normalized);

  if (segments.some((segment) => segment.startsWith(".env"))) return "environment file";
  if (/\.keychain/i.test(basename)) return "keychain";

  if (segments[0] === "Users" && segments.length >= 3) {
    if (segments[2] === ".ssh") return "SSH credentials";
    if (segments[2] === ".aws") return "AWS credentials";
    if (segments[2] === "Library" && segments[3] === "Keychains") return "keychain";
    if (segments[2] === ".codex" && segments[3] === "auth.json") return "Codex auth";
    if (segments[2] === ".config" && segments[3] === "gh") return "GitHub CLI auth";
  }
  return undefined;
}

function assertNotDenied(candidate: string, phase: string): void {
  const kind = deniedPathKind(candidate);
  if (kind) throw new ScopeError(`${phase} path is denylisted (${kind})`, candidate);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function matchesPolicy(candidate: string, patterns: string[] | undefined): boolean {
  if (!patterns) return true;
  return patterns.some((pattern) => {
    const absolutePattern = path.resolve(pattern);
    if (absolutePattern.includes("*") || absolutePattern.includes("?")) {
      return globToRegExp(absolutePattern).test(candidate);
    }
    return candidate === absolutePattern || candidate.startsWith(`${absolutePattern}${path.sep}`);
  });
}

export async function resolveScope(
  scope: TaskScope,
  policy: ScopePolicy = {},
): Promise<ResolvedScope> {
  const resolvedPaths: string[] = [];
  for (const requested of scope.paths) {
    if (!path.isAbsolute(requested)) {
      throw new ScopeError("scope paths must be absolute", requested);
    }

    // This lexical check deliberately happens before any filesystem operation.
    assertNotDenied(requested, "requested");
    let resolved: string;
    try {
      resolved = await realpath(requested);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      throw new ScopeError(`scope path could not be resolved (${code})`, requested);
    }
    assertNotDenied(resolved, "resolved");

    if (!matchesPolicy(resolved, policy.systemPaths)) {
      throw new ScopeError("path exceeds system capability", resolved);
    }
    if (!matchesPolicy(resolved, policy.userPaths)) {
      throw new ScopeError("path exceeds user restrictions", resolved);
    }
    if (!matchesPolicy(resolved, policy.peerPaths)) {
      throw new ScopeError("path exceeds peer-originated task restrictions", resolved);
    }
    resolvedPaths.push(resolved);
  }

  return { ...scope, paths: [...new Set(resolvedPaths)] };
}
