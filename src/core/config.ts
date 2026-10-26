import path from "node:path";

export function resolveTtbHome(
  configured = process.env.BATTALION_HOME ?? process.env.TTB_HOME,
  home = process.env.HOME,
): string {
  const candidate = configured ?? (home ? path.join(home, ".ttb") : undefined);
  if (!candidate) throw new Error("TTB_HOME is unset and HOME is unavailable");
  if (candidate === "~" || candidate.startsWith(`~${path.sep}`)) {
    throw new Error("TTB_HOME must not use an unexpanded ~");
  }
  return path.resolve(candidate);
}
