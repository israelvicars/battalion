import { open, readFile, unlink } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Envelope } from "./envelope.ts";
import { assertSafeSlug, isSafeSlug } from "./ids.ts";
import type { ResolvedScope } from "./scope.ts";
import { AuditLog } from "./audit.ts";
import { Redactor, sha256 } from "./redaction.ts";

type LockRecord = {
  lead: string;
  pid: number;
  ts: string;
};

export type LeadLockHandle = {
  taskId: string;
  filename: string;
  serialized: string;
  envelope: Envelope & { scope: ResolvedScope };
};

export class LeadLockError extends Error {
  locked_by: string;

  constructor(lockedBy: string) {
    super(`Task is locked_by: ${lockedBy}`);
    this.name = "LeadLockError";
    this.locked_by = lockedBy;
  }
}

export type LeadLockManagerOptions = {
  pid?: number;
  pidAlive?: (pid: number) => boolean;
};

export class LeadLockManager {
  readonly directory: string;
  private audit: AuditLog;
  private redactor: Redactor;
  private pid: number;
  private pidAlive: (pid: number) => boolean;

  constructor(
    ttbHome: string,
    audit: AuditLog,
    redactor = new Redactor(),
    options: LeadLockManagerOptions = {},
  ) {
    this.directory = path.join(path.resolve(ttbHome), "locks");
    this.audit = audit;
    this.redactor = redactor;
    this.pid = options.pid ?? process.pid;
    this.pidAlive = options.pidAlive ?? ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    });
  }

  async acquire(envelope: Envelope & { scope: ResolvedScope }): Promise<LeadLockHandle> {
    assertSafeSlug(envelope.task_id, "task_id");
    assertSafeSlug(envelope.lead, "lead");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, `${envelope.task_id}.lock`);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record: LockRecord = { lead: envelope.lead, pid: this.pid, ts: new Date().toISOString() };
      const serialized = `${JSON.stringify(record)}\n`;
      try {
        const handle = await open(filename, "wx", 0o600);
        try {
          await handle.write(serialized);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.auditEvent("lock.acquired", envelope, true, envelope.lead, null);
        return { taskId: envelope.task_id, filename, serialized, envelope };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const existing = await this.readExisting(filename);
      if (existing && !this.pidAlive(existing.pid) && attempt === 0) {
        await this.auditEvent("lock.stale_break", envelope, true, existing.lead, null);
        await unlink(filename);
        continue;
      }

      const lockedBy = existing?.lead ?? "unknown";
      await this.auditEvent("lock.rejected", envelope, false, lockedBy, `locked_by:${lockedBy}`);
      throw new LeadLockError(lockedBy);
    }
    throw new Error("Failed to acquire lead lock after stale-lock recovery");
  }

  async release(handle: LeadLockHandle): Promise<boolean> {
    let current: string;
    try {
      current = await readFile(handle.filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (current !== handle.serialized) return false;
    await unlink(handle.filename);
    await this.auditEvent("lock.released", handle.envelope, true, handle.envelope.lead, null);
    return true;
  }

  private async readExisting(filename: string): Promise<LockRecord | undefined> {
    try {
      const text = await readFile(filename, { encoding: "utf8", flag: "r" });
      if (Buffer.byteLength(text) > 4096) return undefined;
      const value = JSON.parse(text) as Partial<LockRecord>;
      if (!isSafeSlug(value.lead) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
          typeof value.ts !== "string" || !Number.isFinite(Date.parse(value.ts))) return undefined;
      return value as LockRecord;
    } catch {
      return undefined;
    }
  }

  private async auditEvent(
    event: string,
    envelope: Envelope & { scope: ResolvedScope },
    ok: boolean,
    result: string,
    errorReason: string | null,
  ): Promise<void> {
    const prompt = this.redactor.redact(envelope.prompt);
    const safeResult = this.redactor.redact(result);
    await this.audit.append({
      event,
      task_id: envelope.task_id,
      thread_id: envelope.thread_id,
      agent: "hub",
      scope: envelope.scope,
      redaction_hits: prompt.hits + safeResult.hits,
      prompt_sha256: sha256(envelope.prompt),
      prompt_preview: prompt.text,
      result_sha256: sha256(safeResult.text),
      exit: null,
      ok,
      error_reason: errorReason,
      usage: null,
    });
  }
}
