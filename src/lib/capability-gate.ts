/**
 * capability-gate
 *
 * Makes a WebMCP tool's existence a function of user consent.
 *
 * WebMCP has no `unregisterTool`. A tool is revoked by aborting the AbortSignal
 * passed to `registerTool`. One AbortController per grant is therefore the whole
 * mechanism: grant registers, revoke aborts, expiry aborts on a timer.
 *
 * Verified platform behaviour this relies on (probe/FINDINGS.md, Chrome 152):
 *
 *   - Aborting the registration signal removes the tool from getTools().
 *   - A revoked tool cannot be executed even by a caller holding a stale
 *     RegisteredTool handle. Revocation is real, not cosmetic.
 *   - Duplicate names reject with InvalidStateError, so double-grant is guarded
 *     here rather than relying on re-registration to overwrite.
 *   - inputSchema is NOT enforced by the browser, so every capability validates
 *     its own input.
 */

import type { ModelContext, ToolAnnotations } from './webmcp';

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

/** Envelope every gated tool returns, so agents get predictable results. */
export type ToolResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: ToolErrorCode; message: string } };

export type ToolErrorCode =
  /** Input failed the capability's own validation. */
  | 'invalid_input'
  /** Defence in depth: the gate believes this capability is not granted. */
  | 'not_permitted'
  /** The capability's execute threw. */
  | 'failed';

export interface CapabilityDefinition<Input, Output> {
  description: string;
  title?: string;
  inputSchema?: object;
  annotations?: ToolAnnotations;
  /**
   * Validate and narrow raw agent input. Throw to reject the call.
   *
   * Required in practice: Chrome does not validate against inputSchema, so a
   * tool receives whatever the agent sent, including nothing at all.
   */
  validate: (raw: unknown) => Input;
  execute: (input: Input) => Promise<Output> | Output;
  /**
   * Registered at start() and never revocable. For tools that disclose nothing
   * by themselves, such as listing programs or reporting consent state.
   */
  persistent?: boolean;
  /**
   * What to write to the audit log for a successful call. Receives input and
   * output and must return a string safe to persist.
   *
   * The default records only the capability name. Never return a raw source
   * value from here: the audit log is shown to the user and may be exported.
   */
  summarize?: (input: Input, output: Output) => string;
}

export interface GrantOptions {
  /** Milliseconds until the grant expires on its own. Omit for an open grant. */
  ttlMs?: number;
  /** Why the grant was given, shown in the console and recorded in the audit log. */
  reason?: string;
}

export interface CapabilityState {
  name: string;
  description: string;
  granted: boolean;
  persistent: boolean;
  readOnly: boolean;
  /** True when the tool carries agent-authored or cross-boundary content. */
  untrustedContent: boolean;
  /** Epoch ms, or null for an open or absent grant. */
  expiresAt: number | null;
  reason: string | null;
  /** Successful calls made under the current grant. */
  callCount: number;
}

export interface ConsentRequest {
  name: string;
  reason: string;
  requestedAt: number;
}

export type AuditEntry =
  | { type: 'granted'; name: string; at: number; ttlMs: number | null; reason: string | null }
  | { type: 'revoked'; name: string; at: number; cause: 'user' | 'expiry' | 'teardown' }
  | { type: 'called'; name: string; at: number; summary: string }
  | { type: 'denied'; name: string; at: number; code: ToolErrorCode; message: string }
  | { type: 'requested'; name: string; at: number; reason: string };

export interface GateSnapshot {
  capabilities: CapabilityState[];
  pending: ConsentRequest[];
}

export interface CapabilityGateOptions {
  modelContext?: ModelContext | undefined;
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => number;
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

interface Entry {
  name: string;
  /** Erased to unknown so definitions of differing shapes share one map. */
  def: CapabilityDefinition<unknown, unknown>;
  controller: AbortController | null;
  expiresAt: number | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  reason: string | null;
  callCount: number;
}

export class CapabilityGateError extends Error {}

/* ------------------------------------------------------------------ *
 * Gate
 * ------------------------------------------------------------------ */

export class CapabilityGate {
  #mc: ModelContext | undefined;
  #now: () => number;
  #entries = new Map<string, Entry>();
  #pending = new Map<string, ConsentRequest>();
  #audit: AuditEntry[] = [];
  #subscribers = new Set<(snapshot: GateSnapshot) => void>();
  #started = false;

  constructor(options: CapabilityGateOptions = {}) {
    this.#mc = options.modelContext ?? document.modelContext;
    this.#now = options.now ?? (() => Date.now());
  }

  /** False when WebMCP is unavailable, so callers can degrade instead of throwing. */
  get available(): boolean {
    return Boolean(this.#mc);
  }

  /**
   * Declare a capability without granting it. The tool does not exist in the
   * registry until grant(), which is the entire point.
   */
  define<Input, Output>(name: string, def: CapabilityDefinition<Input, Output>): this {
    if (this.#entries.has(name)) {
      throw new CapabilityGateError(`capability "${name}" is already defined`);
    }
    // Names are constrained by the spec: 1-128 chars, alphanumeric plus _ - .
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
      throw new CapabilityGateError(`capability name "${name}" is not a valid tool name`);
    }
    this.#entries.set(name, {
      name,
      def: def as unknown as CapabilityDefinition<unknown, unknown>,
      controller: null,
      expiresAt: null,
      expiryTimer: null,
      reason: null,
      callCount: 0,
    });
    return this;
  }

  /** Register every persistent capability. Call once, after all define() calls. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const entry of this.#entries.values()) {
      if (entry.def.persistent) {
        await this.#register(entry, { reason: 'always available' });
      }
    }
    this.#emit();
  }

  /**
   * Grant a capability, registering its tool. Optionally time-boxed.
   *
   * Re-granting an already granted capability is a no-op that only extends the
   * window, because duplicate registration rejects at the platform level.
   */
  async grant(name: string, options: GrantOptions = {}): Promise<void> {
    const entry = this.#requireEntry(name);
    if (entry.def.persistent) {
      throw new CapabilityGateError(`"${name}" is persistent and cannot be granted`);
    }

    // Already granted: adjust the window instead of registering twice.
    if (entry.controller) {
      this.#scheduleExpiry(entry, options.ttlMs);
      entry.reason = options.reason ?? entry.reason;
      this.#emit();
      return;
    }

    await this.#register(entry, options);
    this.#pending.delete(name);
    this.#emit();
  }

  /** Revoke a capability, unregistering its tool immediately. */
  revoke(name: string): void {
    const entry = this.#requireEntry(name);
    this.#teardown(entry, 'user');
    this.#emit();
  }

  /** Revoke everything revocable. */
  revokeAll(): void {
    for (const entry of this.#entries.values()) {
      if (!entry.def.persistent) this.#teardown(entry, 'user');
    }
    this.#emit();
  }

  /**
   * Record that the agent asked for a capability it does not have.
   *
   * Non-blocking by design: the tool call returns immediately so the agent is
   * never left hanging on a human. The agent re-checks consent state and
   * retries, which also makes the negotiation visible in the transcript.
   */
  requestConsent(name: string, reason: string): ConsentRequest {
    const entry = this.#requireEntry(name);
    if (entry.controller) {
      throw new CapabilityGateError(`"${name}" is already granted`);
    }
    const request: ConsentRequest = { name, reason, requestedAt: this.#now() };
    this.#pending.set(name, request);
    this.#log({ type: 'requested', name, at: request.requestedAt, reason });
    this.#emit();
    return request;
  }

  /** Dismiss a pending request without granting it. */
  denyConsent(name: string): void {
    this.#pending.delete(name);
    this.#emit();
  }

  isGranted(name: string): boolean {
    return Boolean(this.#entries.get(name)?.controller);
  }

  snapshot(): GateSnapshot {
    return {
      capabilities: [...this.#entries.values()].map((entry) => ({
        name: entry.name,
        description: entry.def.description,
        granted: Boolean(entry.controller),
        persistent: Boolean(entry.def.persistent),
        readOnly: entry.def.annotations?.readOnlyHint === true,
        untrustedContent: entry.def.annotations?.untrustedContentHint === true,
        expiresAt: entry.expiresAt,
        reason: entry.reason,
        callCount: entry.callCount,
      })),
      pending: [...this.#pending.values()],
    };
  }

  /**
   * The tool names the browser currently exposes. This is ground truth, unlike
   * snapshot(), which is the gate's own bookkeeping. UI should prefer this so it
   * cannot drift from reality.
   */
  async liveToolNames(): Promise<string[]> {
    if (!this.#mc) return [];
    return (await this.#mc.getTools()).map((tool) => tool.name);
  }

  audit(): readonly AuditEntry[] {
    return this.#audit;
  }

  subscribe(listener: (snapshot: GateSnapshot) => void): () => void {
    this.#subscribers.add(listener);
    listener(this.snapshot());
    return () => this.#subscribers.delete(listener);
  }

  /** Revoke everything and drop subscribers. */
  destroy(): void {
    for (const entry of this.#entries.values()) {
      this.#teardown(entry, 'teardown');
    }
    this.#subscribers.clear();
  }

  /* ---------------- private ---------------- */

  #requireEntry(name: string): Entry {
    const entry = this.#entries.get(name);
    if (!entry) throw new CapabilityGateError(`unknown capability "${name}"`);
    return entry;
  }

  async #register(entry: Entry, options: GrantOptions): Promise<void> {
    if (!this.#mc) {
      throw new CapabilityGateError('WebMCP is unavailable in this document');
    }

    const controller = new AbortController();
    const tool = {
      name: entry.name,
      description: entry.def.description,
      inputSchema: entry.def.inputSchema ?? { type: 'object', properties: {} },
      annotations: entry.def.annotations ?? {},
      execute: (raw: unknown) => this.#invoke(entry, raw),
      ...(entry.def.title === undefined ? {} : { title: entry.def.title }),
    };

    // Aborting mid-registration rejects this promise, so it is awaited before
    // the controller is stored and errors are surfaced rather than unhandled.
    await this.#mc.registerTool(tool, { signal: controller.signal });

    entry.controller = controller;
    entry.callCount = 0;
    entry.reason = options.reason ?? null;
    this.#scheduleExpiry(entry, options.ttlMs);

    this.#log({
      type: 'granted',
      name: entry.name,
      at: this.#now(),
      ttlMs: options.ttlMs ?? null,
      reason: entry.reason,
    });
  }

  #scheduleExpiry(entry: Entry, ttlMs: number | undefined): void {
    if (entry.expiryTimer) {
      clearTimeout(entry.expiryTimer);
      entry.expiryTimer = null;
    }
    if (ttlMs === undefined) {
      entry.expiresAt = null;
      return;
    }
    entry.expiresAt = this.#now() + ttlMs;
    // An expiring grant is nothing more than a timer that aborts the signal.
    entry.expiryTimer = setTimeout(() => {
      this.#teardown(entry, 'expiry');
      this.#emit();
    }, ttlMs);
  }

  #teardown(entry: Entry, cause: 'user' | 'expiry' | 'teardown'): void {
    if (entry.expiryTimer) {
      clearTimeout(entry.expiryTimer);
      entry.expiryTimer = null;
    }
    if (!entry.controller) return;
    entry.controller.abort();
    entry.controller = null;
    entry.expiresAt = null;
    entry.reason = null;
    this.#log({ type: 'revoked', name: entry.name, at: this.#now(), cause });
  }

  /**
   * Runs a tool call. Errors are returned, not thrown.
   *
   * A thrown error reaches the agent as an opaque UnknownError with no message,
   * so the agent cannot tell a malformed call from a genuine failure. Returning
   * a structured envelope gives it something to act on.
   */
  async #invoke(entry: Entry, raw: unknown): Promise<ToolResult<unknown>> {
    // Defence in depth. Unreachable while the platform holds its guarantee that
    // a revoked tool cannot execute, but cheap insurance if that ever slips.
    if (!entry.controller && !entry.def.persistent) {
      const error = { code: 'not_permitted' as const, message: `"${entry.name}" is not currently permitted` };
      this.#log({ type: 'denied', name: entry.name, at: this.#now(), code: error.code, message: error.message });
      this.#emit();
      return { ok: false, error };
    }

    let input: unknown;
    try {
      input = entry.def.validate(raw);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'input did not validate';
      this.#log({ type: 'denied', name: entry.name, at: this.#now(), code: 'invalid_input', message });
      this.#emit();
      return { ok: false, error: { code: 'invalid_input', message } };
    }

    try {
      const result = await entry.def.execute(input);
      entry.callCount += 1;
      const summary = entry.def.summarize?.(input, result) ?? entry.name;
      this.#log({ type: 'called', name: entry.name, at: this.#now(), summary });
      this.#emit();
      return { ok: true, result };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'execution failed';
      this.#log({ type: 'denied', name: entry.name, at: this.#now(), code: 'failed', message });
      this.#emit();
      return { ok: false, error: { code: 'failed', message } };
    }
  }

  #log(entry: AuditEntry): void {
    this.#audit.push(entry);
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#subscribers) listener(snapshot);
  }
}

export function createCapabilityGate(options?: CapabilityGateOptions): CapabilityGate {
  return new CapabilityGate(options);
}

/* ------------------------------------------------------------------ *
 * Calling helper
 * ------------------------------------------------------------------ */

/**
 * Call a tool by name the way Chrome actually wants it.
 *
 * Chrome's executeTool takes a required JSON string, not an object, and returns
 * a JSON string. Wrapping it once keeps that quirk out of every call site.
 */
export async function callTool<T = unknown>(
  modelContext: ModelContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const tool = (await modelContext.getTools()).find((candidate) => candidate.name === name);
  if (!tool) throw new CapabilityGateError(`tool "${name}" is not registered`);
  return JSON.parse(await modelContext.executeTool(tool, JSON.stringify(args))) as T;
}
