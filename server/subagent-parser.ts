import { Stepper, type Clock } from "./step.ts";

export interface AgentView {
  agentId: string;
  description: string | null;
  agentType: string | null;
  spawnTs: string | null;
  elapsedS: number;
  lastActivityTs: string | null;
  idleS: number;
  lastLabel: string | null;
  rowCount: number;
  ownEndTurn: boolean;
  verdict: "RUNNING" | "FINISHED" | "STALE / POSSIBLY DEAD" | "DEAD";
  isBackground: boolean;
}

const STALE_AFTER_MS = 30_000;

export function parseSubagentLines(lines: string[], clock?: Clock): { stepper: Stepper; lastTs: string | null; ownEndTurn: boolean; rowCount: number; lastLabel: string | null } {
  let ownEndTurn = false;
  let lastTs: string | null = null;
  let rowCount = 0;
  let lastLabel: string | null = null;
  const stepper = new Stepper((label) => {
    lastLabel = label;
  }, 800, clock);

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      rowCount++;
      if (typeof row["timestamp"] === "string") lastTs = row["timestamp"];

      stepper.feed(row);

      if (row["type"] === "assistant") {
        const stopReason = row["stop_reason"];
        ownEndTurn = stopReason === "end_turn";
      } else if (row["type"] === "user") {
        ownEndTurn = false;
      }
    } catch {
      // Ignore half-written lines
    }
  }

  return { stepper, lastTs, ownEndTurn, rowCount, lastLabel };
}

export function parseBackgroundLines(lines: string[]): { label: string | null; rowCount: number } {
  let label: string | null = null;
  let rowCount = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    label = line; // The last non-empty line
    rowCount++;
  }
  return { label, rowCount };
}

export function inspectAgentState(
  agentId: string,
  now: number,
  mtimeMs: number,
  birthtimeMs: number,
  spawnTs: string | null,
  description: string | null,
  agentType: string | null,
  lastTs: string | null,
  lastLabel: string | null,
  rowCount: number,
  ownEndTurn: boolean,
  isBackground: boolean,
  parentTerminal: boolean = false
): AgentView {
  const idleS = Math.max(0, Math.round((now - mtimeMs) / 1000));
  const spawnMs = spawnTs ? Date.parse(spawnTs) : birthtimeMs;
  const elapsedS = Math.max(0, Math.round((now - spawnMs) / 1000));

  let verdict: AgentView["verdict"];
  
  if (ownEndTurn) {
    verdict = "FINISHED";
  } else if (idleS * 1000 < STALE_AFTER_MS) {
    verdict = "RUNNING";
  } else {
    verdict = parentTerminal ? "DEAD" : "STALE / POSSIBLY DEAD";
  }

  return {
    agentId,
    description,
    agentType,
    spawnTs,
    elapsedS,
    lastActivityTs: lastTs,
    idleS,
    lastLabel,
    rowCount,
    ownEndTurn,
    verdict,
    isBackground
  };
}
