import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Draft {
  text: string;
  at: number;
}

const KEY_REGEX = /^(?:new:)?[A-Za-z0-9._-]{1,200}$/;

function draftPath(stateDir: string, key: string): string | null {
  if (!KEY_REGEX.test(key)) return null;
  return join(stateDir, "drafts", `${key}.json`);
}

export function newerDraft(a: Draft, b: Draft): Draft {
  return a.at >= b.at ? a : b;
}

export async function readDraft(stateDir: string, key: string): Promise<Draft> {
  const path = draftPath(stateDir, key);
  if (path === null) return { text: "", at: 0 };
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.text === "string" &&
      typeof parsed.at === "number"
    ) {
      return { text: parsed.text, at: parsed.at };
    }
    return { text: "", at: 0 };
  } catch {
    return { text: "", at: 0 };
  }
}

export async function writeDraft(stateDir: string, key: string, draft: Draft): Promise<Draft> {
  const path = draftPath(stateDir, key);
  if (path === null) return { text: "", at: 0 };
  if (draft.text.length > 200000) return { text: "", at: 0 };

  const current = await readDraft(stateDir, key);
  if (draft.at < current.at) return current;

  if (draft.text.length === 0) {
    try {
      await unlink(path);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    return draft;
  }

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.loom-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify(draft, null, 2) + "\n", "utf8");
  await rename(tmp, path);

  return draft;
}
