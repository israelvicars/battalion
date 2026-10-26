import type { Adapter, NormalizedEvent, TokenUsage } from "../adapters/types.ts";
import type { Envelope } from "./envelope.ts";
import { validateEnvelope } from "./envelope.ts";
import { AuditLog } from "./audit.ts";
import { Redactor, sha256 } from "./redaction.ts";
import { resolveScope } from "./scope.ts";
import type { ScopePolicy } from "./scope.ts";
import { LeadLockManager } from "./lock.ts";
import type { LeadLockHandle } from "./lock.ts";
import { ThreadStore } from "./threads.ts";
import { peerScopeRoots } from "./policy.ts";
import { RunStore } from "./runs.ts";
import path from "node:path";

export type UntrustedResult = {
  untrusted: true;
  from: string;
  text: string;
  ok: boolean;
  exit: number | null;
  error?: {
    reason: string;
    message: string;
  };
  usage?: TokenUsage;
  artifacts?: string[];
  changed_files?: number;
};

export type BrokerOptions = {
  adapters: Adapter[];
  audit: AuditLog;
  scopePolicy?: ScopePolicy;
  redactor?: Redactor;
  onEvent?: (event: NormalizedEvent) => void | Promise<void>;
  locks?: LeadLockManager;
  threads?: ThreadStore;
  runs?: RunStore;
  approvalCheck?: (approvalId: string, envelope: Envelope) => Promise<boolean>;
  peerEnv?: NodeJS.ProcessEnv;
  peerUserHome?: string;
};

type HubBindableAdapter = Adapter & {
  bindHub?: (services: {
    audit: AuditLog;
    redactor: Redactor;
    threads: ThreadStore;
    dispatchInbound: (input: unknown) => Promise<unknown>;
  }) => void;
};

export class Broker {
  private adapters: Map<string, Adapter>;
  private audit: AuditLog;
  private scopePolicy: ScopePolicy;
  private redactor: Redactor;
  private onEvent?: (event: NormalizedEvent) => void | Promise<void>;
  private locks: LeadLockManager;
  private threads: ThreadStore;
  private runs: RunStore;
  private approvalCheck?: (approvalId: string, envelope: Envelope) => Promise<boolean>;
  private peerEnv?: NodeJS.ProcessEnv;
  private peerUserHome?: string;

  constructor(options: BrokerOptions) {
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.manifest().id, adapter]));
    this.audit = options.audit;
    this.scopePolicy = options.scopePolicy ?? {};
    this.redactor = options.redactor ?? new Redactor();
    this.onEvent = options.onEvent;
    this.threads = options.threads ?? new ThreadStore(options.audit.home, this.redactor);
    this.locks = options.locks ?? new LeadLockManager(options.audit.home, options.audit, this.redactor);
    this.runs = options.runs ?? new RunStore(options.audit.home);
    this.approvalCheck = options.approvalCheck;
    this.peerEnv = options.peerEnv;
    this.peerUserHome = options.peerUserHome;
    for (const adapter of this.adapters.values()) {
      (adapter as HubBindableAdapter).bindHub?.({
        audit: this.audit,
        redactor: this.redactor,
        threads: this.threads,
        dispatchInbound: (input) => this.dispatch(input),
      });
    }
  }

  async dispatch(input: unknown): Promise<UntrustedResult> {
    const envelope = validateEnvelope(input);
    const agentId = envelope.to.startsWith("@") ? envelope.to.slice(1) : envelope.to;
    const adapter = this.adapters.get(agentId);
    if (!adapter) throw new Error(`Unknown agent: ${agentId}`);

    if (agentId === "cursor") {
      const approved = envelope.approval_id && this.approvalCheck
        ? await this.approvalCheck(envelope.approval_id, envelope)
        : false;
      if (!approved) throw new Error("Cursor tasks require a resolved approval");
    }

    const peerOriginated = envelope.from === "muse" || envelope.hops > 0;
    let peerPaths: string[] | undefined;
    try {
      peerPaths = peerOriginated
        ? await peerScopeRoots(this.audit.home, this.peerEnv, this.peerUserHome)
        : undefined;
    } catch (error) {
      const prompt = this.redactor.redact(envelope.prompt);
      await this.audit.append({
        event: "scope.config_rejected",
        task_id: envelope.task_id,
        thread_id: envelope.thread_id,
        agent: agentId,
        scope: envelope.scope,
        redaction_hits: prompt.hits,
        prompt_sha256: sha256(envelope.prompt),
        prompt_preview: prompt.text,
        result_sha256: sha256("scope_configuration_rejected"),
        exit: null,
        ok: false,
        error_reason: "scope_configuration_rejected",
        usage: null,
      });
      throw error;
    }
    const resolvedScope = await resolveScope(envelope.scope, { ...this.scopePolicy, peerPaths });
    const checkedEnvelope: Envelope = { ...envelope, scope: resolvedScope };
    const leadLock: LeadLockHandle = await this.locks.acquire(
      checkedEnvelope as Envelope & { scope: typeof resolvedScope },
    );
    let trackedRunId: string | undefined;

    try {
      const runId = await adapter.start(checkedEnvelope);
      trackedRunId = runId;
      const processInfo = adapter.processInfo?.(runId) ?? {};
      await this.runs.add({
        run_id: runId,
        pid: processInfo.pid ?? process.pid,
        pgid: processInfo.pgid ?? null,
        agent: agentId,
        task_id: envelope.task_id,
        thread_id: envelope.thread_id,
      });
      let runError: Extract<NormalizedEvent, { type: "error" }> | undefined;
      let eventUsage: TokenUsage | undefined;

      for await (const event of adapter.events(runId)) {
        // Defense in depth for adapters other than the built-in adapters.
        const safe = this.redactor.redactValue(event).value;
        if (safe.type === "error" && !runError) runError = safe;
        if (safe.type === "cost" &&
          typeof safe.input_tokens === "number" &&
          typeof safe.cached_input_tokens === "number" &&
          typeof safe.cache_write_input_tokens === "number" &&
          typeof safe.output_tokens === "number" &&
          typeof safe.reasoning_output_tokens === "number") {
          eventUsage = {
            input_tokens: safe.input_tokens,
            cached_input_tokens: safe.cached_input_tokens,
            cache_write_input_tokens: safe.cache_write_input_tokens,
            output_tokens: safe.output_tokens,
            reasoning_output_tokens: safe.reasoning_output_tokens,
            ...(typeof safe.total_cost_usd === "number" ? { total_cost_usd: safe.total_cost_usd } : {}),
          };
        }
        if (this.onEvent) await this.onEvent(safe);
      }
      const adapterResult = await adapter.result(runId);
      const artifactRoot = path.join(path.resolve(this.audit.home), "artifacts");
      const artifactRedactions = adapterResult.artifacts.map((artifact) => {
        const resolved = path.resolve(artifact);
        if (resolved.startsWith(`${artifactRoot}${path.sep}`)) return { text: artifact, hits: 0 };
        // Paths outside the hub's own artifact directory are worker-supplied:
        // redact each segment (the path exemption would otherwise hide a token
        // used as a file name), then the whole string as before.
        const segments = artifact.split(path.sep).map((part) => this.redactor.redact(part));
        const whole = this.redactor.redact(segments.map((part) => part.text).join(path.sep));
        return {
          text: whole.text,
          hits: whole.hits + segments.reduce((count, part) => count + part.hits, 0),
        };
      });
      const artifacts = artifactRedactions.map((artifact) => artifact.text);
      const safeOtherResult = this.redactor.redactValue({ ...adapterResult, artifacts: undefined });
      const safeResult = {
        value: { ...safeOtherResult.value, artifacts },
        hits: safeOtherResult.hits + artifactRedactions.reduce((count, artifact) => count + artifact.hits, 0),
      };
      const externallyKilled = await this.runs.isKilled(runId);
      const promptPreview = this.redactor.redact(envelope.prompt);
      const text = externallyKilled ? "" : safeResult.value.text;
      const exit = safeResult.value.exit;
      const usage = safeResult.value.usage ?? eventUsage;
      const resultArtifacts = safeResult.value.artifacts;
      const changedFiles = safeResult.value.changed_files;
      const ok = !externallyKilled && exit === 0 && !runError;
      const error = externallyKilled
        ? { reason: "killed", message: "Worker run was killed" }
        : runError
        ? { reason: runError.reason, message: runError.message.slice(0, 500) }
        : exit !== 0
          ? { reason: "process_exit", message: `Worker exited with status ${String(exit)}` }
          : undefined;
      const redactionHits = promptPreview.hits + safeResult.hits +
        (adapter.redactionHits?.(runId) ?? 0);

      // Persistence, including fsync and the chain-head update, completes before
      // any worker text is returned to the orchestrator.
      await this.audit.append({
        event: "dispatch.completed",
        task_id: envelope.task_id,
        thread_id: envelope.thread_id,
        agent: agentId,
        scope: resolvedScope,
        redaction_hits: redactionHits,
        prompt_sha256: sha256(envelope.prompt),
        prompt_preview: promptPreview.text,
        result_sha256: sha256(text),
        exit,
        ok,
        error_reason: error?.reason ?? null,
        usage: usage ?? null,
      });

      return {
        untrusted: true,
        from: agentId,
        text,
        ok,
        exit,
        ...(error ? { error } : {}),
        ...(usage ? { usage } : {}),
        ...(resultArtifacts.length ? { artifacts: resultArtifacts } : {}),
        ...(changedFiles !== undefined ? { changed_files: changedFiles } : {}),
      };
    } finally {
      if (trackedRunId) {
        await this.runs.clearKilled(trackedRunId);
        await this.runs.remove(trackedRunId);
      }
      await this.locks.release(leadLock);
    }
  }
}
