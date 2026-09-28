/**
 * The pending-permission broker between a blocked PreToolUse hook and the person with the mouse.
 *
 * The hook POSTs a pending tool call and its request is HELD OPEN until someone answers or the
 * broker times out (SPEC 34–35). Timing out resolves "deny": the fail-safe direction,
 * and the same one the CLI takes on its own when the hook dies (DECISIONS.md 2026-08-05).
 */

export type Verdict = "allow" | "deny";

/** A flat string→string map — an AskUserQuestion answer per question text (SPEC: answers format). */
export type Answers = Record<string, string>;

export interface Permit {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  ts: string;
}

/** What a held ask resolves to: the verdict, plus the answers a question card sent with "allow". */
export interface Resolution {
  verdict: Verdict;
  answers?: Answers;
}

interface Held {
  permit: Permit;
  resolve: (resolution: Resolution) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The `/api/permit/answer` body's optional `answers` field, read once so both the route and its
 * unit tests share one definition of "valid" — a flat object of string to string, or absent.
 */
export function readAnswers(value: unknown): { ok: true; answers?: Answers } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false };
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== "string") return { ok: false };
  }
  return { ok: true, answers: value as Answers };
}

export class PermitBroker {
  private readonly held = new Map<string, Held>();

  constructor(
    /** Called whenever a session's pending set changes, so watchers can re-broadcast. */
    private readonly onChange: (sessionId: string) => void,
    private readonly timeoutMs: number,
  ) {}

  /** Register a pending call and wait for the resolution. Resolves "deny" at the timeout. */
  ask(sessionId: string, toolName: string, toolInput: unknown): Promise<Resolution> {
    const permit: Permit = {
      id: crypto.randomUUID(),
      sessionId,
      toolName,
      toolInput,
      ts: new Date().toISOString(),
    };
    return new Promise<Resolution>((resolve) => {
      const timer = setTimeout(() => this.settle(permit.id, "deny"), this.timeoutMs);
      this.held.set(permit.id, { permit, resolve, timer });
      this.onChange(sessionId);
    });
  }

  /** Answer a pending permit. False when the id is unknown — already settled or invented. */
  answer(id: string, verdict: Verdict, answers?: Answers): boolean {
    return this.settle(id, verdict, answers);
  }

  forSession(sessionId: string): Permit[] {
    return [...this.held.values()].map((h) => h.permit).filter((p) => p.sessionId === sessionId);
  }

  private settle(id: string, verdict: Verdict, answers?: Answers): boolean {
    const entry = this.held.get(id);
    if (entry === undefined) return false;
    this.held.delete(id);
    clearTimeout(entry.timer);
    entry.resolve({ verdict, answers });
    this.onChange(entry.permit.sessionId);
    return true;
  }
}
