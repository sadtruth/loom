import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSession, isTerminalState } from "./parser.ts";
import { JulesClient } from "./api.ts";

export function julesClientOrNull(julesDir: string): JulesClient | null {
  const envKey = process.env.JULES_API_KEY?.trim();
  if (envKey && envKey.length > 0) {
    return new JulesClient(envKey);
  }
  
  try {
    const key = readFileSync(join(julesDir, ".key"), "utf8").trim();
    if (key.length > 0) {
      return new JulesClient(key);
    }
  } catch (e) {
    // ignore
  }
  
  return null;
}

export type JulesTask = {
  id: string;              // the Jules session id
  loomSession: string;     // the loom session id that created it, for addressing frames
  title: string;
  prompt: string;
  source: string | null;   // "sources/github/owner/repo", null for a repoless task
  branch: string | null;
  state: string;           // the raw Jules state: QUEUED PLANNING IN_PROGRESS COMPLETED FAILED ...
  createdAt: string;       // ISO
  updatedAt: string;       // ISO
  prUrl: string | null;
  patchFiles: number | null;   // parsed from the unidiff once there is one
  patchAdded: number | null;
  patchRemoved: number | null;
  error: string | null;
};

export async function createTask(
  stateDir: string,
  opts: { loomSession: string; prompt: string; title: string; source: string | null; branch: string | null },
  createSession: () => Promise<any>
): Promise<JulesTask> {
  const rawSession = await createSession();
  const parsed = extractSession(rawSession);
  
  const task: JulesTask = {
    id: parsed.id ?? "unknown-id",
    loomSession: opts.loomSession,
    title: opts.title,
    prompt: opts.prompt,
    source: opts.source,
    branch: opts.branch,
    state: parsed.state ?? "QUEUED",
    createdAt: parsed.createTime ?? new Date().toISOString(),
    updatedAt: parsed.updateTime ?? new Date().toISOString(),
    prUrl: parsed.pullRequest?.url ?? null,
    patchFiles: null,
    patchAdded: null,
    patchRemoved: null,
    error: null,
  };

  await mkdir(join(stateDir, "jules"), { recursive: true });
  await writeFile(join(stateDir, "jules", `${task.id}.json`), JSON.stringify(task, null, 2), "utf8");
  return task;
}

export async function readTask(stateDir: string, id: string): Promise<JulesTask | null> {
  try {
    const content = await readFile(join(stateDir, "jules", `${id}.json`), "utf8");
    return JSON.parse(content) as JulesTask;
  } catch {
    return null;
  }
}

export async function listTasks(stateDir: string): Promise<JulesTask[]> {
  try {
    const files = await readdir(join(stateDir, "jules"));
    const tasks: JulesTask[] = [];
    for (const file of files) {
      if (file.endsWith(".json")) {
        const content = await readFile(join(stateDir, "jules", file), "utf8");
        tasks.push(JSON.parse(content) as JulesTask);
      }
    }
    return tasks;
  } catch {
    return [];
  }
}

function parseDiffStats(patch: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  const lines = patch.split("\n");
  
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      files++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
    }
  }
  
  return { files, added, removed };
}

export async function pollTask(
  stateDir: string,
  id: string,
  fetchSession: (id: string) => Promise<any>
): Promise<JulesTask> {
  const existing = await readTask(stateDir, id);
  if (!existing) throw new Error(`Task ${id} not found`);

  const rawSession = await fetchSession(id);
  const parsed = extractSession(rawSession);
  
  const updated: JulesTask = {
    ...existing,
    state: parsed.state ?? existing.state,
    updatedAt: parsed.updateTime ?? new Date().toISOString(),
    prUrl: parsed.pullRequest?.url ?? existing.prUrl,
  };

  if (parsed.patch) {
    const stats = parseDiffStats(parsed.patch);
    updated.patchFiles = stats.files;
    updated.patchAdded = stats.added;
    updated.patchRemoved = stats.removed;
  }

  await writeFile(join(stateDir, "jules", `${id}.json`), JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

const activePollers = new Map<string, ReturnType<typeof setInterval>>();

export function testActivePollerCount(): number {
  return activePollers.size;
}

export function startPolling(
  stateDir: string,
  id: string,
  report: (task: JulesTask) => void,
  fetchSession: (id: string) => Promise<any>
): void {
  if (activePollers.has(id)) return;

  const timer = setInterval(async () => {
    try {
      const existing = await readTask(stateDir, id);
      if (!existing) {
        stopPolling(id);
        return;
      }
      
      const previousState = existing.state;
      const updated = await pollTask(stateDir, id, fetchSession);
      
      if (updated.state !== previousState) {
        report(updated);
      }
      
      if (isTerminalState(updated.state)) {
        stopPolling(id);
      }
    } catch (e) {
      // Intentionally swallow fetch errors during polling so transient failures don't crash the timer
      console.error(`Error polling task ${id}:`, e);
    }
  }, 20000);
  
  activePollers.set(id, timer);
}

export function stopPolling(id: string): void {
  const timer = activePollers.get(id);
  if (timer) {
    clearInterval(timer);
    activePollers.delete(id);
  }
}
