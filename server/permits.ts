/**
 * The pending-permission broker between a blocked PreToolUse hook and the person with the mouse.
 *
 * The hook POSTs a pending tool call and its request is HELD OPEN until someone answers or the
 * broker times out (SPEC 34–35). Timing out resolves "deny": the fail-safe direction,
 * and the same one the CLI takes on its own when the hook dies (DECISIONS.md 2026-08-05).
 */

export type Verdict = "allow" | "deny";

export interface Permit {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  ts: string;
}

interface Held {
  permit: Permit;
  resolve: (verdict: Verdict) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PermitBroker {
  private readonly held = new Map<string, Held>();

  constructor(
    /** Called whenever a session's pending set changes, so watchers can re-broadcast. */
    private readonly onChange: (sessionId: string) => void,
    private readonly timeoutMs: number,
  ) {}

  /** Register a pending call and wait for the verdict. Resolves "deny" at the timeout. */
  ask(sessionId: string, toolName: string, toolInput: unknown): Promise<Verdict> {
    const permit: Permit = {
      id: crypto.randomUUID(),
      sessionId,
      toolName,
      toolInput,
      ts: new Date().toISOString(),
    };
    return new Promise<Verdict>((resolve) => {
      const timer = setTimeout(() => this.settle(permit.id, "deny"), this.timeoutMs);
      this.held.set(permit.id, { permit, resolve, timer });
      this.onChange(sessionId);
    });
  }

  /** Answer a pending permit. False when the id is unknown — already settled or invented. */
  answer(id: string, verdict: Verdict): boolean {
    return this.settle(id, verdict);
  }

  forSession(sessionId: string): Permit[] {
    return [...this.held.values()].map((h) => h.permit).filter((p) => p.sessionId === sessionId);
  }

  private settle(id: string, verdict: Verdict): boolean {
    const entry = this.held.get(id);
    if (entry === undefined) return false;
    this.held.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(verdict);
    this.onChange(entry.permit.sessionId);
    return true;
  }
}
