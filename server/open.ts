/**
 * Opening a path from a chip click. SPEC §13.
 *
 * The vault root is DISCOVERED (walk up for a .obsidian directory), not hardcoded: this project syncs
 * between /Users/user/docs on the Mac and /home/user/resilio/docs on the box, and a hardcoded root
 * would silently fall back to Finder on one of them.
 *
 * Every spawn uses an argv array and never a shell string — these paths come from a browser.
 */

import { access } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface OpenResult {
  ok: boolean;
  how: "obsidian" | "reveal" | "none";
  target: string;
  /**
   * The BROWSER is to navigate `target` — it is a URI, not a path, and navigating it opens the note
   * on whichever device is at the keyboard (requirement 224).
   */
  navigate?: boolean;
  /** Where the process actually ran, for anything that could only happen here. */
  host?: string;
  error?: string;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Nearest ancestor containing .obsidian, or null. */
export async function findVaultRoot(start: string): Promise<string | null> {
  let dir = start;
  for (let i = 0; i < 40; i += 1) {
    if (await exists(`${dir}/.obsidian`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function obsidianUri(vaultRoot: string, path: string): string {
  const vault = vaultRoot.split(sep).slice(-1)[0] ?? "vault";
  const rel = relative(vaultRoot, path);
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(rel)}`;
}

async function spawn(cmd: readonly string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn([...cmd], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function openPath(rawPath: string): Promise<OpenResult> {
  const path = resolve(expandHome(rawPath));
  if (!isAbsolute(path)) return { ok: false, how: "none", target: path, error: "not absolute" };
  if (!(await exists(path))) return { ok: false, how: "none", target: path, error: "not found" };

  const vaultRoot = await findVaultRoot(path);
  const mac = platform() === "darwin";

  // A VAULT NOTE IS MACHINE-INDEPENDENT, so it is handed to the browser rather than to a process
  // here (requirement 224). The Obsidian URI names the vault by NAME, not by path, so whichever
  // device is at the keyboard opens its own copy — and this used to spawn the opener on the box and
  // report success for a window that had appeared 700km away.
  if (vaultRoot !== null && path.endsWith(".md")) {
    return { ok: true, how: "obsidian", target: obsidianUri(vaultRoot, path), navigate: true };
  }

  // Everything else spawns a process, and a process spawns where the server is. That is a weak
  // outcome away from home, which is exactly why READING never comes through here — the file pane
  // shows the box's disk to every device. What this owes the reader is honesty about the machine,
  // rather than a toast that implies the local one.
  const ok = mac ? await spawn(["open", "-R", path]) : await spawn(["xdg-open", dirname(path)]);
  return { ok, how: "reveal", target: path, host: hostname(), ...(ok ? {} : { error: "opener failed" }) };
}
