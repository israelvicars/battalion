import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { assertSafeSlug, isHubGeneratedApprovalId } from "./ids.ts";
import { Redactor } from "./redaction.ts";

export type ThreadMessage = {
  task_id: string;
  thread_id: string;
  from: string;
  to: string;
  kind: "outbound_task" | "inbound_reply" | "inbound_task" | "outbound_reply" | "comparison";
  text: string;
  untrusted: boolean;
  agree?: string;
  disagree?: string;
  changed_decision?: "yes" | "no" | "unknown";
};

export type StoredThreadMessage = ThreadMessage & {
  ts: string;
  redaction_hits: number;
  approval_id?: string;
};

function pendingApprovalText(id: string): string {
  return `PENDING APPROVAL: ${id}`;
}

/**
 * Redact stored thread messages for display, keeping only hub-written
 * "PENDING APPROVAL: <id>" texts verbatim when the id has the strict
 * hub-generated format. Everything else goes through the normal redactor.
 */
export function redactThreadMessagesForDisplay(redactor: Redactor, messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const safe = redactor.redactValue(messages).value as Array<Record<string, unknown>>;
  return safe.map((message, index) => {
    const original = messages[index];
    const id = original?.approval_id;
    if (isHubGeneratedApprovalId(id) && original.text === pendingApprovalText(id)) {
      return { ...message, approval_id: id, text: pendingApprovalText(id) };
    }
    return message;
  });
}

export type ThreadAppendOptions = {
  hubGeneratedApprovalId?: string;
};

export class ThreadStore {
  readonly directory: string;
  private redactor: Redactor;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(ttbHome: string, redactor = new Redactor()) {
    this.directory = path.join(path.resolve(ttbHome), "threads");
    this.redactor = redactor;
  }

  pathFor(threadId: string): string {
    assertSafeSlug(threadId, "thread_id");
    return path.join(this.directory, `${threadId}.jsonl`);
  }

  append(message: ThreadMessage, options: ThreadAppendOptions = {}): Promise<StoredThreadMessage> {
    assertSafeSlug(message.task_id, "task_id");
    const filename = this.pathFor(message.thread_id);
    const perform = async (): Promise<StoredThreadMessage> => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const approvalId = options.hubGeneratedApprovalId;
      const isPendingApproval = approvalId !== undefined &&
        isHubGeneratedApprovalId(approvalId) &&
        message.text === `PENDING APPROVAL: ${approvalId}`;
      const redactedMessage = isPendingApproval
        ? { ...message, text: "PENDING APPROVAL: __TTB_APPROVAL_ID__" }
        : message;
      const safe = this.redactor.redactValue(redactedMessage);
      if (isPendingApproval) safe.value.text = pendingApprovalText(approvalId);
      const record: StoredThreadMessage = {
        ...safe.value,
        ...(isPendingApproval ? { approval_id: approvalId } : {}),
        ts: new Date().toISOString(),
        redaction_hits: safe.hits,
      };
      const handle = await open(filename, "a", 0o600);
      try {
        await handle.write(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return record;
    };
    const next = this.operation.then(perform, perform);
    this.operation = next;
    return next;
  }
}
