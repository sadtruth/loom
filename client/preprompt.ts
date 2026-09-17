/** The preprompt panel: a cheap model gathers context beside the session, and you decide what
 *  reaches the expensive one.
 *
 * One card per job, newest first. The card shows what the gather is doing WHILE it does it -
 * the commands as they run, the step count, the tokens - because the whole point of gathering
 * in a child process is that you can watch it and stop it, not wait blind for a result.
 *
 * Three buttons, which are the three things you can want: send it into the session, ask for
 * another round on the same artifact, or throw it away. Nothing here writes to the transcript;
 * Accept posts to the server, which sends the message the way a typed one goes.
 */

export interface GatherHandle {
  jobId: string;
  slug: string;
}

interface CardParts {
  root: HTMLElement;
  state: HTMLElement;
  meta: HTMLElement;
  log: HTMLElement;
  accept: HTMLButtonElement;
  more: HTMLButtonElement;
  discard: HTMLButtonElement;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

export class PrepromptPanel {
  private cards = new Map<string, CardParts>();

  constructor(
    private host: HTMLElement,
    /** Where an accepted package goes when there is no session to send it to. */
    private toComposer: (text: string) => void = () => {},
  ) {}

  /** Start a round and show its card. The prompt is the text the composer had. */
  async gather(sessionId: string, prompt: string, roots: string[] = []): Promise<GatherHandle | null> {
    const url =
      sessionId === "" ? "/api/preprompt" : `/api/sessions/${encodeURIComponent(sessionId)}/preprompt`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, roots }),
    });
    if (!response.ok) {
      const said = await response.text().catch(() => "");
      this.note(
        response.status === 401 || response.status === 403
          ? "gather refused: this browser is not signed in to loom - open the /login?token= link once"
          : `gather refused: ${response.status} ${said.slice(0, 200)}`,
      );
      return null;
    }
    const handle = (await response.json()) as GatherHandle;
    const card = this.card(handle, prompt);
    this.listen(handle, card);
    return handle;
  }

  private note(text: string): void {
    // The panel starts hidden, so a note prepended to a hidden panel is a failure nobody sees.
    // That is exactly what happened on 2026-09-17: an unauthenticated browser pressed gather,
    // the POST came back 401, and the button looked broken instead of refused.
    const line = element("div", "pp-note", text);
    this.host.hidden = false;
    this.host.prepend(line);
    setTimeout(() => {
      line.remove();
      if (this.host.childElementCount === 0) this.host.hidden = true;
    }, 10000);
  }

  private card(handle: GatherHandle, prompt: string): CardParts {
    const root = element("section", "pp-card");
    const head = element("header", "pp-head");
    const state = element("span", "pp-state", "gathering");
    head.append(state, element("span", "pp-slug", handle.slug));
    const question = element("div", "pp-question", prompt);
    const meta = element("div", "pp-meta", "no commands yet");
    const log = element("ol", "pp-log");

    const buttons = element("div", "pp-buttons");
    const accept = element("button", "pp-accept", "Accept into session");
    const more = element("button", "pp-more", "Ask for more");
    const discard = element("button", "pp-discard", "Discard");
    accept.type = "button";
    more.type = "button";
    discard.type = "button";
    buttons.append(accept, more, discard);

    root.append(head, question, meta, log, buttons);
    this.host.prepend(root);
    this.host.hidden = false;

    const parts: CardParts = { root, state, meta, log, accept, more, discard };
    this.cards.set(handle.jobId, parts);

    accept.addEventListener("click", () => void this.accept(handle, parts));
    more.addEventListener("click", () => void this.more(handle, parts));
    discard.addEventListener("click", () => void this.discard(handle, parts));
    return parts;
  }

  /** The stream carries the history first, so a panel opened late is not a panel that missed it. */
  private listen(handle: GatherHandle, card: CardParts): void {
    const source = new EventSource(`/api/preprompt/${handle.jobId}/events`);
    let commands = 0;
    let step = 0;
    let tokens = { in: 0, out: 0 };
    let model = "";

    const meta = () => {
      const bits = [`${commands} commands`, `step ${step}`];
      if (model !== "") bits.push(model);
      if (tokens.in > 0) bits.push(`${tokens.in} in / ${tokens.out} out`);
      card.meta.textContent = bits.join("  ·  ");
    };

    source.addEventListener("command", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as {
        command: string;
        exitCode: number | null;
        durationMs: number;
        refused: string;
      };
      commands += 1;
      const line = element("li", data.refused ? "pp-cmd pp-refused" : "pp-cmd");
      line.textContent = data.refused
        ? `${data.command} - refused: ${data.refused.slice(0, 120)}`
        : `${data.command}  (${data.durationMs}ms)`;
      card.log.append(line);
      card.log.scrollTop = card.log.scrollHeight;
      meta();
    });

    source.addEventListener("step", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as {
        step: number;
        model: string | null;
        promptTokens: number;
        completionTokens: number;
      };
      step = data.step;
      tokens = { in: data.promptTokens, out: data.completionTokens };
      if (data.model) model = data.model;
      meta();
    });

    source.addEventListener("note", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { text: string };
      const line = element("li", "pp-cmd pp-note-line", `note: ${data.text}`);
      card.log.append(line);
    });

    source.addEventListener("done", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { stopReason: string };
      card.state.textContent = "ready";
      card.root.classList.add("pp-done");
      card.meta.textContent = `${card.meta.textContent}  ·  ${data.stopReason}`;
      source.close();
    });

    source.addEventListener("error", (event) => {
      // Two different errors arrive here: the server's own "error" event, which carries a
      // message, and the browser's transport error, which carries nothing. Only the first is
      // worth showing; the second happens on every normal close.
      const raw = (event as MessageEvent).data;
      if (typeof raw !== "string") return;
      const data = JSON.parse(raw) as { message: string };
      card.state.textContent = "failed";
      card.root.classList.add("pp-failed");
      card.meta.textContent = data.message;
      source.close();
    });
  }

  private async accept(handle: GatherHandle, card: CardParts): Promise<void> {
    card.accept.disabled = true;
    const response = await fetch(`/api/preprompt/${handle.jobId}/accept`, { method: "POST" });
    if (response.status === 204) {
      card.state.textContent = "sent";
      card.root.classList.add("pp-sent");
      return;
    }
    if (response.ok) {
      // No session yet: the package lands in the composer and you send it yourself.
      const body = (await response.json()) as { text?: string };
      if (typeof body.text === "string") {
        this.toComposer(body.text);
        card.state.textContent = "in the composer";
        card.root.classList.add("pp-sent");
        return;
      }
    }
    card.accept.disabled = false;
    card.meta.textContent = `accept failed: ${response.status}`;
  }

  private async more(handle: GatherHandle, card: CardParts): Promise<void> {
    const text = window.prompt("What else should it look for?");
    if (text === null || text.trim() === "") return;
    const response = await fetch(`/api/preprompt/${handle.jobId}/gap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      card.meta.textContent = `another round refused: ${response.status}`;
      return;
    }
    card.state.textContent = "gathering";
    card.root.classList.remove("pp-done");
    this.listen(handle, card);
  }

  private async discard(handle: GatherHandle, card: CardParts): Promise<void> {
    await fetch(`/api/preprompt/${handle.jobId}`, { method: "DELETE" });
    card.root.remove();
    this.cards.delete(handle.jobId);
    if (this.cards.size === 0) this.host.hidden = true;
  }
}

export function mountPreprompt(
  host: HTMLElement,
  toComposer: (text: string) => void = () => {},
): PrepromptPanel {
  return new PrepromptPanel(host, toComposer);
}
