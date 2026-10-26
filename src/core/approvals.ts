import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Envelope } from "./envelope.ts";
import { assertSafeSlug } from "./ids.ts";
import { canonicalJson } from "./audit.ts";
import type { AuditLog } from "./audit.ts";
import { Redactor, sha256 } from "./redaction.ts";

export type ApprovalStatus = "pending" | "approved" | "denied";

export type ApprovalRecord = {
  id: string;
  status: ApprovalStatus;
  agent: string;
  created_at: string;
  resolved_at?: string;
  source_filename?: string;
  prompt_preview: string;
  redaction_hits: number;
  envelope: Envelope;
};

export type ApprovalClaim = {
  record: ApprovalRecord;
  filename: string;
  claimPath: string;
};

export class ApprovalStore {
  readonly directory: string;
  private audit: AuditLog;
  private redactor: Redactor;

  constructor(ttbHome: string, audit: AuditLog, redactor = new Redactor()) {
    this.directory = path.join(path.resolve(ttbHome), "approvals");
    this.audit = audit;
    this.redactor = redactor;
  }

  pathFor(id: string): string {
    assertSafeSlug(id, "approval id");
    return path.join(this.directory, `${id}.json`);
  }

  async create(envelope: Envelope, sourceFilename: string): Promise<ApprovalRecord> {
    return this.createForAgent("muse", envelope, sourceFilename);
  }

  async createForAgent(agent: string, envelope: Envelope, sourceFilename?: string): Promise<ApprovalRecord> {
    assertSafeSlug(agent, "approval agent");
    const id = envelope.task_id.length <= 123 - agent.length
      ? `${agent}-${envelope.task_id}`
      : `${agent}-${sha256(envelope.task_id).slice(0, 32)}`;
    assertSafeSlug(id, "approval id");
    const safePrompt = this.redactor.redact(envelope.prompt);
    const record: ApprovalRecord = {
      id,
      status: "pending",
      agent,
      created_at: new Date().toISOString(),
      ...(sourceFilename ? { source_filename: sourceFilename } : {}),
      prompt_preview: safePrompt.text.slice(0, 200),
      redaction_hits: safePrompt.hits,
      envelope: { ...envelope, prompt: safePrompt.text },
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const handle = await open(this.pathFor(id), "wx", 0o600);
    try {
      await handle.write(`${JSON.stringify(record, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.auditRecord("approval.requested", record, true, null);
    return record;
  }

  async isApproved(id: string, envelope: Envelope): Promise<boolean> {
    const record = await this.read(id);
    const { approval_id: _approvalId, ...candidate } = envelope;
    return record.status === "approved" && record.envelope.to.replace(/^@/, "") === envelope.to.replace(/^@/, "") &&
      canonicalJson(record.envelope) === canonicalJson(candidate);
  }

  async list(status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: ApprovalRecord[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = await this.read(name.slice(0, -5));
        if (!status || record.status === status) records.push(record);
      } catch {
        // Ignore malformed records in listings; direct access reports the error.
      }
    }
    return records;
  }

  async read(id: string): Promise<ApprovalRecord> {
    const record = JSON.parse(await readFile(this.pathFor(id), "utf8")) as ApprovalRecord;
    if (record.id !== id || !["pending", "approved", "denied"].includes(record.status)) {
      throw new Error(`Malformed approval: ${id}`);
    }
    return record;
  }

  async claim(id: string): Promise<ApprovalClaim> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.pathFor(id);
    const claimPath = `${filename}.claim`;
    let handle;
    try {
      handle = await open(claimPath, "wx", 0o600);
      await handle.write(`${JSON.stringify({ pid: process.pid, ts: new Date().toISOString() })}\n`);
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Approval ${id} is already being resolved`);
      }
      throw error;
    } finally {
      await handle?.close();
    }
    try {
      const record = await this.read(id);
      if (record.status !== "pending") throw new Error(`Approval ${id} is already ${record.status}`);
      return { record, filename, claimPath };
    } catch (error) {
      await unlink(claimPath).catch(() => {});
      throw error;
    }
  }

  async finish(claim: ApprovalClaim, status: "approved" | "denied"): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      ...claim.record,
      status,
      resolved_at: new Date().toISOString(),
    };
    const temporary = `${claim.filename}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, claim.filename);
    await unlink(claim.claimPath);
    await this.auditRecord(`approval.${status}`, record, true, null);
    return record;
  }

  async release(claim: ApprovalClaim): Promise<void> {
    await unlink(claim.claimPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async auditRecord(
    event: string,
    record: ApprovalRecord,
    ok: boolean,
    errorReason: string | null,
  ): Promise<void> {
    const prompt = this.redactor.redact(record.envelope.prompt);
    await this.audit.append({
      event,
      task_id: record.envelope.task_id,
      thread_id: record.envelope.thread_id,
      agent: record.agent === "muse" ? "muse-vaultdrop" : record.agent,
      scope: record.envelope.scope,
      redaction_hits: record.redaction_hits + prompt.hits,
      prompt_sha256: sha256(record.envelope.prompt),
      prompt_preview: prompt.text,
      result_sha256: sha256(record.status),
      exit: null,
      ok,
      error_reason: errorReason,
      usage: null,
    });
  }
}
