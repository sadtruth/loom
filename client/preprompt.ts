/** The gathered package, drawn in the transcript under the question that started it.
 *
 * It lives in the conversation and not in a side rail, because it IS a turn: a cheap model read
 * the tree and this is what it found. You read it where you read everything else, and then you
 * decide whether the expensive model gets it.
 *
 * What it shows, and why each part is there:
 *   - every command with the time it ran and its COMPLETE output. A list of command names tells
 *     you a model was busy; the output is the only thing that tells you whether it found anything.
 *     No durations - they say nothing about the answer.
 *   - the model's own reading, in its words, so you can see what it thinks it learned.
 *   - the package itself, before you accept it: a button that sends something you cannot read is
 *     not a decision.
 */

export interface GatherHandle {
  jobId: string;
  slug: string;
}

interface Card {
  root: HTMLElement;
  status: HTMLElement;
  head: HTMLElement;
  band: HTMLElement;
  commands: HTMLElement;
  packageBox: HTMLDetailsElement;
  packageText: HTMLElement;
  ask: HTMLTextAreaElement;
  accept: HTMLButtonElement;
  more: HTMLButtonElement;
  discard: HTMLButtonElement;
  started: number;
  model: string;
  step: number;
  tokensIn: number;
  tokensOut: number;
  timer: ReturnType<typeof setInterval> | null;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== "") element.className = className;
  if (text !== "") element.textContent = text;
  return element;
}

const STEP_CEILING = 25;

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function hhmmss(iso: string): string {
  if (iso === "") return "";
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? "" : when.toTimeString().slice(0, 8);
}

export class PrepromptPanel {
  private cards = new Map<string, Card>();
  /** Which session each card was gathered for, and which session the composer is showing. A card
   * drawn in one chat used to stay on the screen in every other chat (2026-09-18). */
  private owner = new Map<string, string>();
  private showing = "";

  /** Loom owns the transcript body and rebuilds it whenever the session redraws, which takes any
   *  node we put there with it - the card would appear, run, and vanish mid-gather. Rather than
   *  fight it for ownership, the cards watch for their own removal and put themselves back. */
  private watcher: MutationObserver | null = null;

  constructor(
    /** The composer. The card is inserted directly before it, so it lands under the last
     *  message and above the input - loom moves the composer into the transcript body, so a
     *  fixed container in the markup ends up somewhere else entirely. */
    private composer: HTMLElement,
    /** Where an accepted package goes when there is no session to send it to. */
    private toComposer: (text: string) => void = () => {},
  ) {}

  async gather(
    sessionId: string,
    prompt: string,
    roots: string[] = [],
    project = "",
  ): Promise<GatherHandle | null> {
    const url =
      sessionId === "" ? "/api/preprompt" : `/api/sessions/${encodeURIComponent(sessionId)}/preprompt`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, roots, project }),
    });
    if (!response.ok) {
      const said = await response.text().catch(() => "");
      this.complain(
        response.status === 401 || response.status === 403
          ? "gather refused: this browser is not signed in to loom — open the /login?token= link once"
          : `gather refused: ${response.status} ${said.slice(0, 200)}`,
      );
      return null;
    }
    const handle = (await response.json()) as GatherHandle;
    remember(handle.jobId);
    this.owner.set(handle.jobId, sessionId);
    this.showing = sessionId;
    this.listen(handle, this.draw(handle, prompt));
    return handle;
  }

  /** After a reload the children are still running; the page just forgot about them. */
  async reattach(): Promise<void> {
    // Ask for all of them and filter here. A gather started before the session existed belongs
    // to no session, and asking the server "which are mine?" loses exactly those - the ones the
    // feature is for.
    const response = await fetch("/api/preprompt");
    if (!response.ok) return;
    const body = (await response.json()) as {
      jobs?: {
        jobId: string;
        slug: string;
        prompt: string;
        state: string;
        accepted: boolean;
        sessionId: string;
      }[];
    };
    for (const job of body.jobs ?? []) {
      if (this.cards.has(job.jobId)) continue;
      // Only the gathers this browser started. The server remembers every job it is running,
      // including other people's and other tabs', and drawing those puts someone else's
      // questions in your conversation.
      if (!mine().includes(job.jobId)) continue;
      // Only a gather that is still running comes back by itself. A finished one has had its
      // answer; redrawing it on every load fills the page with packages you already dealt with.
      if (job.state !== "running") continue;
      // No session filter. At page load the session id is not resolved yet, so filtering by it
      // dropped every job that HAS one - which is most of them - and the reload redrew nothing.
      // Few jobs are ever open at once, and each card names the question it came from.
      // Only what still wants a decision: a live gather, or a finished one you have not sent or
      // thrown away. Redrawing every job the server remembers turns a reload into a pile of old
      // packages you already dealt with.
      if (job.accepted) continue;
      this.owner.set(job.jobId, job.sessionId);
      const handle = { jobId: job.jobId, slug: job.slug };
      this.listen(handle, this.draw(handle, job.prompt));
    }
  }

  /** Show only what was gathered for this session. A gather that started before the session had
   * an id belongs to whatever the composer opens next, so it stays visible. */
  showSession(sessionId: string): void {
    this.showing = sessionId;
    for (const [jobId, card] of this.cards) card.root.hidden = this.hiddenFor(jobId);
  }

  private hiddenFor(jobId: string): boolean {
    const mine = this.owner.get(jobId) ?? "";
    if (mine === "" || this.showing === "") return false;
    return mine !== this.showing;
  }

  private complain(text: string): void {
    const line = node("div", "pp-complaint", text);
    this.composer.parentElement?.insertBefore(line, this.composer);
    line.scrollIntoView({ block: "nearest" });
    setTimeout(() => line.remove(), 12000);
  }

  private draw(handle: GatherHandle, prompt: string): Card {
    const root = node("article", "pp-pkg");
    root.dataset["job"] = handle.jobId;

    const head = node("header", "pp-pkg-head");
    const badge = node("span", "pp-badge", "gathered context");
    const status = node("span", "pp-status", "gathering");
    head.append(badge, status);

    const task = node("blockquote", "pp-task", prompt);
    const band = node("p", "pp-band", "a cheap model is reading the tree for this question");
    // The log is a fold of its own with a scroll inside it: fourteen commands with their output
    // is four thousand pixels, and a card that tall pushes the composer and the three buttons off
    // the screen - the parts you actually decide with.
    const logBox = document.createElement("details");
    logBox.className = "pp-log-box";
    logBox.open = true;
    const logSummary = document.createElement("summary");
    logSummary.textContent = "commands";
    const commands = node("div", "pp-cmds");
    logBox.append(logSummary, commands);

    const packageBox = document.createElement("details");
    packageBox.className = "pp-package";
    const summary = document.createElement("summary");
    summary.textContent = "what Accept will send — nothing gathered yet";
    const packageText = node("pre", "pp-package-text");
    packageBox.append(summary, packageText);

    const ask = document.createElement("textarea");
    ask.className = "pp-ask";
    ask.rows = 2;
    ask.placeholder = "what else should it look for? (Ask for more runs another round on the same artifact)";

    const buttons = node("div", "pp-buttons");
    const accept = node("button", "pp-accept", "Accept → send");
    const more = node("button", "pp-more", "Ask for more");
    const discard = node("button", "pp-discard", "Discard");
    for (const button of [accept, more, discard]) button.type = "button";
    // Another round on a job that is still gathering is refused by the server anyway; saying so
    // with the button costs nothing and does not depend on a network round trip to find out.
    more.disabled = true;
    buttons.append(accept, more, discard);

    root.append(head, task, band, logBox, packageBox, ask, buttons);
    this.place(root);
    this.keepPlaced();
    root.scrollIntoView({ block: "end", behavior: "smooth" });

    const card: Card = {
      root,
      status,
      head,
      band,
      commands,
      packageBox,
      packageText,
      ask,
      accept,
      more,
      discard,
      started: Date.now(),
      model: "",
      step: 0,
      tokensIn: 0,
      tokensOut: 0,
      timer: null,
    };
    this.cards.set(handle.jobId, card);
    card.root.hidden = this.hiddenFor(handle.jobId);

    card.timer = setInterval(() => this.head(card), 1000);
    this.head(card);

    accept.addEventListener("click", () => void this.accept(handle, card));
    more.addEventListener("click", () => void this.more(handle, card));
    discard.addEventListener("click", () => void this.discard(handle, card));
    return card;
  }

  private place(root: HTMLElement): void {
    const parent = this.composer.parentElement;
    if (parent === null) return;
    parent.insertBefore(root, this.composer);
  }

  /** One observer for all cards: when a redraw drops one out of the document, put it back where
   *  it belongs. Cheap - it only looks when the document actually changed. */
  private keepPlaced(): void {
    if (this.watcher !== null) return;
    this.watcher = new MutationObserver(() => {
      for (const card of this.cards.values()) {
        if (!card.root.isConnected) this.place(card.root);
      }
    });
    this.watcher.observe(document.body, { childList: true, subtree: true });
  }

  /** One line of plain facts, each labelled: an unlabelled number is a number nobody can use. */
  private head(card: Card): void {
    const bits: string[] = [];
    if (card.model !== "") bits.push(card.model);
    bits.push(`step ${card.step} of ${STEP_CEILING}`);
    if (card.tokensIn > 0) {
      bits.push(
        `${card.tokensIn.toLocaleString()} tokens read · ${card.tokensOut.toLocaleString()} written`,
      );
    }
    bits.push(clock(Date.now() - card.started));
    let meta = card.head.querySelector<HTMLElement>(".pp-meta");
    if (meta === null) {
      meta = node("span", "pp-meta");
      card.head.append(meta);
    }
    meta.textContent = bits.join("  ·  ");
  }

  private listen(handle: GatherHandle, card: Card): void {
    const source = new EventSource(`/api/preprompt/${handle.jobId}/events`);

    source.addEventListener("command", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as {
        n: number;
        command: string;
        at: string;
        exitCode: number | null;
        refused: string;
        output: string;
        stderr: string;
      };
      const block = node("div", data.refused === "" ? "pp-cmd" : "pp-cmd pp-cmd-refused");
      const line = node("div", "pp-cmd-line");
      line.append(node("code", "pp-cmd-text", data.command), node("time", "pp-cmd-at", hhmmss(data.at)));
      block.append(line);
      if (data.refused !== "") {
        block.append(node("pre", "pp-cmd-out pp-refused-out", data.refused));
      } else {
        const body =
          data.output.trim() === ""
            ? data.stderr.trim() === ""
              ? "(no output)"
              : data.stderr
            : data.output;
        // Complete, but not shouting: a 200-row listing at the top of the card buries everything
        // under it. The first lines are shown and the rest is one click away, never dropped.
        const lines = body.split("\n");
        if (lines.length <= 14) {
          block.append(node("pre", "pp-cmd-out", body));
        } else {
          const stub = node("pre", "pp-cmd-out", lines.slice(0, 10).join("\n"));
          const rest = document.createElement("details");
          rest.className = "pp-rest";
          const summary = document.createElement("summary");
          summary.textContent = `${lines.length - 10} more lines`;
          rest.append(summary, node("pre", "pp-cmd-out", lines.slice(10).join("\n")));
          block.append(stub, rest);
        }
      }
      card.commands.append(block);
      const fold = card.commands.parentElement?.querySelector("summary");
      if (fold !== null && fold !== undefined) {
        fold.textContent = `${card.commands.childElementCount} commands, with what each printed`;
      }
      card.band.textContent = `${card.model === "" ? "a cheap model" : card.model} ran these commands to gather context:`;
    });

    source.addEventListener("step", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as {
        step: number;
        model: string | null;
        promptTokens: number;
        completionTokens: number;
      };
      card.step = data.step;
      card.tokensIn = data.promptTokens;
      card.tokensOut = data.completionTokens;
      if (data.model) card.model = data.model;
      this.head(card);
    });

    // Notes are not part of the package any more - every one written in testing was invented -
    // and old runs on disk still carry them, so the panel ignores them entirely.

    source.addEventListener("artifact-updated", () => void this.refreshPackage(handle, card));

    source.addEventListener("done", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { stopReason: string };
      // "ready" is a claim about the result, so it has to be earned. A run whose model died on
      // its second call still ends with exit 0 and an artifact of 790 bytes; calling that ready
      // is how you get handed nothing and told it is something.
      const gathered = card.commands.childElementCount;
      const failedEarly = /returned nothing|malformed|no choices|rate limit/i.test(data.stopReason);
      if (gathered === 0 || failedEarly) {
        card.status.textContent = `stopped without gathering much — ${data.stopReason}`;
        card.root.classList.add("pp-failed");
      } else if (data.stopReason.includes("ceiling")) {
        card.status.textContent = "ready — it stopped at the step limit, not because it was finished";
        card.root.classList.add("pp-ready");
      } else {
        card.status.textContent = `ready — ${data.stopReason}`;
        card.root.classList.add("pp-ready");
      }
      card.more.disabled = false;
      card.band.title = data.stopReason;
      if (card.timer !== null) clearInterval(card.timer);
      card.timer = null;
      this.head(card);
      void this.refreshPackage(handle, card);
      source.close();
    });

    source.addEventListener("error", (event) => {
      const raw = (event as MessageEvent).data;
      if (typeof raw !== "string") return;
      const data = JSON.parse(raw) as { message: string };
      card.status.textContent = `failed: ${data.message}`;
      card.root.classList.add("pp-failed");
      card.more.disabled = false;
      if (card.timer !== null) clearInterval(card.timer);
      card.timer = null;
      source.close();
    });
  }

  /** The package, exactly as Accept would send it. Read before you send, not after. */
  private async refreshPackage(handle: GatherHandle, card: Card): Promise<void> {
    const response = await fetch(`/api/preprompt/${handle.jobId}/package`);
    if (!response.ok) return;
    const body = (await response.json()) as { text?: string };
    const text = body.text ?? "";
    card.packageText.textContent = text;
    const summary = card.packageBox.querySelector("summary");
    if (summary !== null) {
      summary.textContent =
        text.trim() === ""
          ? "what Accept will send — nothing gathered yet"
          : `what Accept will send — ${text.length.toLocaleString()} characters`;
    }
  }

  private async accept(handle: GatherHandle, card: Card): Promise<void> {
    card.accept.disabled = true;
    const response = await fetch(`/api/preprompt/${handle.jobId}/accept`, { method: "POST" });
    if (response.status === 204) {
      this.settle(card, handle);
      return;
    }
    if (response.ok) {
      const body = (await response.json()) as { text?: string; why?: string };
      if (typeof body.text === "string") {
        this.toComposer(body.text);
        this.settle(card, handle);
        return;
      }
    }
    card.accept.disabled = false;
    card.status.textContent = `accept failed: ${response.status}`;
  }

  /** Once it has been accepted, the decision is made: the card folds to one line so the
   *  conversation continues under it instead of behind it. The evidence is one click away. */
  /** Accepted means done with. The package is in the session or in the composer; leaving the
   *  card behind just pushes the conversation around. */
  private settle(card: Card, handle: GatherHandle): void {
    card.root.remove();
    this.cards.delete(handle.jobId);
  }

  private async more(handle: GatherHandle, card: Card): Promise<void> {
    const text = card.ask.value.trim();
    if (text === "") {
      card.ask.focus();
      card.status.textContent = "write what else it should look for, then press Ask for more";
      return;
    }
    const response = await fetch(`/api/preprompt/${handle.jobId}/gap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      card.status.textContent = `another round refused: ${response.status}`;
      return;
    }
    card.ask.value = "";
    // The stream replays the job's whole history to every new reader, so the commands already on
    // screen would be appended a second time. Clear, and let the replay redraw them once.
    card.commands.replaceChildren();
    card.more.disabled = true;
    card.status.textContent = "gathering";
    card.root.classList.remove("pp-ready");
    card.started = Date.now();
    if (card.timer === null) card.timer = setInterval(() => this.head(card), 1000);
    this.listen(handle, card);
  }

  private async discard(handle: GatherHandle, card: Card): Promise<void> {
    await fetch(`/api/preprompt/${handle.jobId}`, { method: "DELETE" });
    if (card.timer !== null) clearInterval(card.timer);
    card.root.remove();
    this.cards.delete(handle.jobId);
  }
}

const MINE = "preprompt-jobs";

function mine(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(MINE) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function remember(jobId: string): void {
  try {
    sessionStorage.setItem(MINE, JSON.stringify([...mine(), jobId].slice(-20)));
  } catch {
    // a browser with no session storage still gets the live panel, just not the reload
  }
}

export function mountPreprompt(
  composer: HTMLElement,
  toComposer: (text: string) => void = () => {},
): PrepromptPanel {
  return new PrepromptPanel(composer, toComposer);
}
