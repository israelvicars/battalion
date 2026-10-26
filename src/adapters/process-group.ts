import { readdir, readFile } from "node:fs/promises";

/**
 * True when a member of the process group is alive and not a zombie.
 *
 * A zombie member means the process is dead and only waiting to be reaped,
 * which is the OS's job, not the caller's; counting it as alive makes the
 * result depend on init's reaping speed. On systems without /proc (macOS,
 * Windows) fall back to the kill() probe, which reports the group gone only
 * once it is fully reaped.
 */
export async function groupHasLiveMember(pid: number | undefined): Promise<boolean> {
  if (!pid) return false;
  if (process.platform === "win32") {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  }
  try {
    const entries = await readdir("/proc");
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = await readFile(`/proc/${entry}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const fields = stat.slice(close + 2).split(" ");
        if (Number(fields[2]) === pid && fields[0] !== "Z") return true;
      } catch { /* process exited mid-scan */ }
    }
    return false;
  } catch {
    try { process.kill(-pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  }
}
