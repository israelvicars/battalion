import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { TokenUsage } from "../adapters/types.ts";
import type { ResolvedScope } from "./scope.ts";
import { sha256 } from "./redaction.ts";

export type AuditRecordInput = {
  event: string;
  task_id: string;
  thread_id: string;
  agent: string;
  scope: ResolvedScope;
  redaction_hits: number;
  prompt_sha256: string;
  prompt_preview: string;
  result_sha256: string;
  exit: number | null;
  ok: boolean;
  error_reason: string | null;
  usage: TokenUsage | null;
};

export type AuditRecord = Omit<AuditRecordInput, "scope"> & {
  ts: string;
  seq: number;
  prev_hash: string;
  hash: string;
  scope_summary: {
    path_count: number;
    write: false | "throwaway";
    network: false;
    machine: "macbook";
  };
};

export type AuditVerification = {
  valid: boolean;
  line?: number;
  error?: string;
  records?: number;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function withoutHash(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.hash;
  return copy;
}

function localIsoTimestamp(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const pad = (number: number, width = 2): string => String(Math.abs(number)).padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.trunc(offsetMinutes / 60))}:` +
    `${pad(offsetMinutes % 60)}`;
}

async function readOptional(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function verifyAudit(filename: string): Promise<AuditVerification> {
  const content = await readOptional(filename);
  const lines = content?.split("\n").filter((line) => line.length > 0) ?? [];
  let previousHash = "0".repeat(64);
  let lastHash = previousHash;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[index]) as Record<string, unknown>;
    } catch {
      return { valid: false, line: lineNumber, error: "invalid JSON" };
    }
    if (parsed.seq !== lineNumber) {
      return { valid: false, line: lineNumber, error: "sequence mismatch" };
    }
    if (parsed.prev_hash !== previousHash) {
      return { valid: false, line: lineNumber, error: "previous hash mismatch" };
    }
    const expected = sha256(canonical(withoutHash(parsed)));
    if (parsed.hash !== expected) {
      return { valid: false, line: lineNumber, error: "hash mismatch" };
    }
    previousHash = expected;
    lastHash = expected;
  }

  const headText = await readOptional(`${filename}.head`);
  if (headText !== undefined) {
    try {
      const head = JSON.parse(headText) as { seq?: unknown; hash?: unknown };
      if (head.seq !== lines.length || head.hash !== lastHash) {
        return {
          valid: false,
          line: Math.min(lines.length + 1, Number(head.seq) || lines.length + 1),
          error: "audit head mismatch (possible tail deletion)",
        };
      }
    } catch {
      return { valid: false, line: lines.length + 1, error: "invalid audit head" };
    }
  }
  return { valid: true, records: lines.length };
}

export class AuditLog {
  readonly home: string;
  readonly path: string;
  private operation: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private seq = 0;
  private previousHash = "0".repeat(64);
  private readonly lockPath: string;

  constructor(ttbHome: string) {
    this.home = path.resolve(ttbHome);
    this.path = path.join(this.home, "audit", "audit.jsonl");
    this.lockPath = `${this.path}.lock`;
  }

  private async acquireLock(): Promise<FileHandle> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        try {
          await handle.write(`${process.pid}\n`);
          await handle.sync();
        } catch (error) {
          await handle.close();
          await unlink(this.lockPath).catch(() => undefined);
          throw error;
        }
        return handle;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

        const lockText = await readOptional(this.lockPath);
        const pid = Number.parseInt(lockText?.trim() ?? "", 10);
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
              await unlink(this.lockPath).catch(() => undefined);
              continue;
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error(`Timed out acquiring audit lock: ${this.lockPath}`);
  }

  private async releaseLock(handle: FileHandle): Promise<void> {
    try {
      await handle.close();
    } finally {
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const verification = await verifyAudit(this.path);
    if (!verification.valid) {
      throw new Error(`Cannot append to invalid audit at line ${verification.line}: ${verification.error}`);
    }
    const content = await readOptional(this.path);
    const lines = content?.split("\n").filter(Boolean) ?? [];
    if (lines.length > 0) {
      const last = JSON.parse(lines.at(-1) as string) as AuditRecord;
      this.seq = last.seq;
      this.previousHash = last.hash;
    }
    this.initialized = true;
  }

  private async refreshTail(): Promise<void> {
    const content = await readOptional(this.path);
    const lines = content?.split("\n").filter(Boolean) ?? [];
    if (lines.length === 0) {
      this.seq = 0;
      this.previousHash = "0".repeat(64);
      return;
    }
    const last = JSON.parse(lines.at(-1) as string) as AuditRecord;
    this.seq = last.seq;
    this.previousHash = last.hash;
  }

  append(input: AuditRecordInput): Promise<AuditRecord> {
    const perform = async (): Promise<AuditRecord> => {
      await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
      const lock = await this.acquireLock();
      try {
        await this.initialize();
        await this.refreshTail();
        const scope_summary = {
          path_count: input.scope.paths.length,
          write: input.scope.write,
          network: input.scope.network,
          machine: input.scope.machine,
        };
        const base = {
          ts: localIsoTimestamp(),
          seq: this.seq + 1,
          prev_hash: this.previousHash,
          event: input.event,
          task_id: input.task_id,
          thread_id: input.thread_id,
          agent: input.agent,
          scope_summary,
          redaction_hits: input.redaction_hits,
          prompt_sha256: input.prompt_sha256,
          prompt_preview: input.prompt_preview.slice(0, 200),
          result_sha256: input.result_sha256,
          exit: input.exit ?? null,
          ok: input.ok ?? false,
          error_reason: input.error_reason ?? null,
          usage: input.usage ?? null,
        };
        const hash = sha256(canonical(base));
        // Scope paths are intentionally summarized rather than persisted.
        const record: AuditRecord = { ...base, hash };

        const logHandle = await open(this.path, "a", 0o600);
        try {
          await logHandle.write(`${JSON.stringify(record)}\n`);
          await logHandle.sync();
        } finally {
          await logHandle.close();
        }

        const headPath = `${this.path}.head`;
        const temporaryHead = `${headPath}.tmp-${process.pid}`;
        await writeFile(temporaryHead, `${JSON.stringify({ seq: record.seq, hash })}\n`, { mode: 0o600 });
        await rename(temporaryHead, headPath);
        this.seq = record.seq;
        this.previousHash = hash;
        return record;
      } finally {
        await this.releaseLock(lock);
      }
    };
    const next = this.operation.then(perform, perform);
    this.operation = next;
    return next;
  }
}

export { canonical as canonicalJson };
