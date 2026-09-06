import { watch, statSync, readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { parseSubagentLines, parseBackgroundLines, inspectAgentState, type AgentView } from "./subagent-parser.ts";
import { Runner } from "./input.ts";

export class SubagentWatcher {
  private watchers = new Map<string, ReturnType<typeof watch>>();
  private knownFiles = new Set<string>();
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessionDir: string,
    private readonly onEmit: (frame: any) => void,
    private readonly runner: Runner,
    private readonly sessionId: string
  ) {}

  public start() {
    this.pollDir();
    // Poll the directory occasionally to find new subagents without relying entirely on fs.watch for directories
    this.poller = setInterval(() => this.pollDir(), 2000);
  }

  /**
   * Clears the poller as well as the file watchers.
   *
   * The interval closure holds `this`; `this.onEmit` closes over the Watcher that built it; and
   * that Watcher holds the Tailer with a whole session's parsed transcript. So an uncleared
   * interval did not leak a timer — it leaked one session's transcript per detach, and went on
   * calling readdirSync every two seconds for a session nobody was reading. Measured on prod
   * 2026-09-06: 6.3 GB resident after 14 hours, with the GC threads busy the whole time
   * (record item 88).
   */
  public stop() {
    if (this.poller !== null) clearInterval(this.poller);
    this.poller = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private pollDir() {
    const subagentsDir = join(this.sessionDir, "subagents");
    if (existsSync(subagentsDir)) {
      try {
        const files = readdirSync(subagentsDir).filter(f => f.endsWith(".jsonl"));
        for (const file of files) {
          if (!this.knownFiles.has(file)) {
            this.knownFiles.add(file);
            this.watchFile(join(subagentsDir, file), file, false);
          }
        }
      } catch (e) {}
    }

    const tasksDir = join(this.sessionDir, "tasks");
    if (existsSync(tasksDir)) {
      try {
        const files = readdirSync(tasksDir).filter(f => f.endsWith(".output"));
        for (const file of files) {
          if (!this.knownFiles.has(file)) {
            this.knownFiles.add(file);
            this.watchFile(join(tasksDir, file), file, true);
          }
        }
      } catch (e) {}
    }
  }

  private watchFile(fullPath: string, fileName: string, isBackground: boolean) {
    // Read and emit initial state immediately
    this.readAndEmit(fullPath, fileName, isBackground);

    try {
      const w = watch(fullPath, () => {
        this.readAndEmit(fullPath, fileName, isBackground);
      });
      this.watchers.set(fileName, w);
    } catch (e) {
      // Ignore watch errors if file goes away or system limits
    }
  }

  private readAndEmit(fullPath: string, fileName: string, isBackground: boolean) {
    let content = "";
    let mtimeMs = Date.now();
    let birthtimeMs = Date.now();
    try {
      const stats = statSync(fullPath);
      mtimeMs = stats.mtimeMs;
      birthtimeMs = stats.birthtimeMs;
      content = readFileSync(fullPath, "utf-8");
    } catch (e) {
      return;
    }

    const lines = content.split("\n");
    const parentTerminal = !this.runner.running(this.sessionId);

    let view: AgentView;
    if (isBackground) {
      const agentId = fileName.replace(".output", "");
      const { label, rowCount } = parseBackgroundLines(lines);
      view = inspectAgentState(
        agentId, Date.now(), mtimeMs, birthtimeMs, null, "Background Task", null, null, label, rowCount, false, true, parentTerminal
      );
    } else {
      const agentId = fileName.replace(/^agent-/, "").replace(/\.jsonl$/, "");
      const { lastTs, ownEndTurn, rowCount, lastLabel } = parseSubagentLines(lines);
      
      let description = null;
      let agentType = null;
      let spawnTs = null;
      try {
        const metaPath = join(this.sessionDir, "subagents", `agent-${agentId}.meta.json`);
        if (existsSync(metaPath)) {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          description = meta.description;
          agentType = meta.agentType;
        }
      } catch (e) {}

      view = inspectAgentState(
        agentId, Date.now(), mtimeMs, birthtimeMs, spawnTs, description, agentType, lastTs, lastLabel, rowCount, ownEndTurn, false, parentTerminal
      );
    }

    this.onEmit({
      type: "subagent",
      ...view
    });
  }
}
