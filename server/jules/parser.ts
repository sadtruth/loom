import type {
  ParsedActivity,
  ParsedSession,
  ParsedSource,
  PullRequestInfo,
  SessionState,
} from "./types.ts";

const KNOWN_STATES: SessionState[] = [
  "QUEUED",
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "IN_PROGRESS",
  "AWAITING_USER_FEEDBACK",
  "PAUSED",
  "COMPLETED",
  "FAILED",
];

/**
 * Searches an object tolerantly for candidate keys (case-insensitive) up to maxDepth levels deep.
 */
export function findKeyTolerantly(
  obj: any,
  candidateKeys: string[],
  maxDepth = 2
): any {
  if (!obj || typeof obj !== "object") return undefined;

  const normalizedCandidates = candidateKeys.map((k) =>
    k.toLowerCase().replace(/[-_]/g, "")
  );

  // Check top level first
  for (const [key, value] of Object.entries(obj)) {
    const normKey = key.toLowerCase().replace(/[-_]/g, "");
    if (normalizedCandidates.includes(normKey) && value !== undefined && value !== null) {
      return value;
    }
  }

  if (maxDepth <= 0) return undefined;

  // Search 1..maxDepth levels down
  for (const [, value] of Object.entries(obj)) {
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object") {
            const nested = findKeyTolerantly(item, candidateKeys, maxDepth - 1);
            if (nested !== undefined && nested !== null) {
              return nested;
            }
          }
        }
      } else {
        const nested = findKeyTolerantly(value, candidateKeys, maxDepth - 1);
        if (nested !== undefined && nested !== null) {
          return nested;
        }
      }
    }
  }

  return undefined;
}

/**
 * Tolerantly extracts session state from raw response data.
 */
export function extractSessionState(data: any): SessionState | undefined {
  if (!data || typeof data !== "object") return undefined;

  const stateVal = findKeyTolerantly(data, [
    "state",
    "sessionState",
    "status",
    "lifecycleState",
    "phase",
    "sessionStatus",
  ]);

  if (typeof stateVal === "string") {
    const upper = stateVal.toUpperCase();
    const matched = KNOWN_STATES.find((s) => s === upper);
    if (matched) return matched;
    return stateVal;
  }

  // Fallback: search for known state strings anywhere in the object values
  let foundKnownState: SessionState | undefined;
  function scanForState(curr: any, depth = 0) {
    if (!curr || depth > 2 || foundKnownState) return;
    if (typeof curr === "string") {
      const upper = curr.toUpperCase();
      if (KNOWN_STATES.includes(upper)) {
        foundKnownState = upper;
      }
    } else if (typeof curr === "object") {
      for (const val of Object.values(curr)) {
        scanForState(val, depth + 1);
      }
    }
  }

  scanForState(data);
  return foundKnownState;
}

/**
 * Tolerantly extracts session ID or resource name.
 */
export function extractSessionId(data: any): string | undefined {
  if (!data) return undefined;
  if (typeof data === "string") return data;
  if (typeof data !== "object") return undefined;

  const idVal = findKeyTolerantly(data, [
    "name",
    "id",
    "sessionId",
    "session_id",
    "sessionName",
  ]);

  if (typeof idVal === "string" && idVal.length > 0) {
    return idVal;
  }

  return undefined;
}

/**
 * Tolerantly extracts Pull Request information (URL, title, description).
 */
export function extractPullRequest(data: any): PullRequestInfo | undefined {
  if (!data || typeof data !== "object") return undefined;

  let prUrl: string | undefined;
  let prTitle: string | undefined;
  let prDesc: string | undefined;
  let prBranch: string | undefined;

  // Check common PR container objects
  const prContainer = findKeyTolerantly(data, [
    "pullRequest",
    "pull_request",
    "pullRequestOutput",
    "pr",
    "prOutput",
    "gitHubPr",
    "githubPullRequest",
    "output",
    "result",
  ]);

  const target = (prContainer && typeof prContainer === "object") ? prContainer : data;

  const urlCandidate = findKeyTolerantly(target, [
    "pullRequestUrl",
    "pull_request_url",
    "prUrl",
    "pr_url",
    "url",
    "htmlUrl",
    "html_url",
    "targetUrl",
  ]);
  if (typeof urlCandidate === "string" && /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(urlCandidate)) {
    prUrl = urlCandidate;
  }

  const titleCandidate = findKeyTolerantly(target, [
    "prTitle",
    "pullRequestTitle",
    "pull_request_title",
    "title",
    "subject",
  ]);
  if (typeof titleCandidate === "string") {
    prTitle = titleCandidate;
  }

  const descCandidate = findKeyTolerantly(target, [
    "prDescription",
    "pullRequestDescription",
    "pull_request_description",
    "description",
    "summary",
    "body",
  ]);
  if (typeof descCandidate === "string") {
    prDesc = descCandidate;
  }

  const branchCandidate = findKeyTolerantly(target, [
    "branch",
    "headBranch",
    "prBranch",
    "sourceBranch",
    "branchName",
  ]);
  if (typeof branchCandidate === "string") {
    prBranch = branchCandidate;
  }

  // Fallback: deep search for GitHub PR URL string anywhere in data
  if (!prUrl) {
    function findPrUrl(curr: any, depth = 0) {
      if (!curr || depth > 3 || prUrl) return;
      if (typeof curr === "string") {
        const match = curr.match(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i);
        if (match && match[0]) {
          prUrl = match[0];
        }
      } else if (typeof curr === "object") {
        for (const val of Object.values(curr)) {
          findPrUrl(val, depth + 1);
        }
      }
    }
    findPrUrl(data);
  }

  if (prUrl || prTitle || prDesc || prBranch) {
    return {
      url: prUrl,
      title: prTitle,
      description: prDesc,
      branch: prBranch,
    };
  }

  return undefined;
}

/**
 * Tolerantly extracts session details into a unified ParsedSession.
 */
export function parseDiffStats(unidiff: string): { files: number; added: number; removed: number } {
  const lines = unidiff.split("\n");
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("diff ") || line.startsWith("--- a/") || (line.startsWith("+++ b/") && !lines.find(l => l.startsWith("diff ")))) {
      // rough heuristic: if we see diff --git or --- a/ we usually count it, but let's just count --- a/ to be safe
      // Actually standard git diff has diff --git
      // So we count "diff --git" or if not present "--- a/"
    }
    if (line.startsWith("diff --git ")) {
      files++;
    } else if (line.startsWith("--- a/") && !unidiff.includes("diff --git ")) {
      files++;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
    }
  }
  return { files, added, removed };
}

export function extractSession(data: any): ParsedSession {
  const raw = data;
  const id = extractSessionId(data);
  const state = extractSessionState(data);
  const pullRequest = extractPullRequest(data);
  
  let patch: string | undefined;
  const unidiffCandidate = findKeyTolerantly(data, ["unidiffPatch", "unidiff", "patch"], 5);
  if (typeof unidiffCandidate === "string") {
    patch = unidiffCandidate;
  }

  const title = findKeyTolerantly(data, ["title", "sessionTitle", "displayName"]);
  const prompt = findKeyTolerantly(data, ["prompt", "userPrompt", "initialPrompt", "description"]);
  const createTime = findKeyTolerantly(data, ["createTime", "create_time", "createdAt", "created_at", "time"]);
  const updateTime = findKeyTolerantly(data, ["updateTime", "update_time", "updatedAt", "updated_at"]);
  const source = findKeyTolerantly(data, ["source", "sourceName", "repository"]);
  const branch = findKeyTolerantly(data, ["startingBranch", "branch", "branchName"]);

  return {
    id: typeof id === "string" ? id : undefined,
    state,
    title: typeof title === "string" ? title : undefined,
    prompt: typeof prompt === "string" ? prompt : undefined,
    createTime: typeof createTime === "string" ? createTime : undefined,
    updateTime: typeof updateTime === "string" ? updateTime : undefined,
    source: typeof source === "string" ? source : undefined,
    branch: typeof branch === "string" ? branch : undefined,
    pullRequest,
    patch,
    raw,
  };
}

/**
 * Tolerantly extracts a list of sources from the API response.
 */
export function extractSources(data: any): ParsedSource[] {
  if (!data) return [];
  let list: any[] = [];

  if (Array.isArray(data)) {
    list = data;
  } else if (typeof data === "object") {
    const candidateArrays = [
      "sources",
      "items",
      "repos",
      "repositories",
      "sourceList",
      "connectedSources",
    ];
    for (const key of candidateArrays) {
      if (Array.isArray(data[key])) {
        list = data[key];
        break;
      }
    }
    if (list.length === 0) {
      for (const val of Object.values(data)) {
        if (Array.isArray(val)) {
          list = val;
          break;
        }
      }
    }
  }

  return list.map((item) => {
    if (typeof item === "string") {
      return { name: item, raw: item };
    }
    if (item && typeof item === "object") {
      const name =
        findKeyTolerantly(item, ["name", "id", "source", "repo", "uri", "displayName"]) ||
        JSON.stringify(item);
      const repo = findKeyTolerantly(item, ["repo", "githubRepo", "repository", "fullName"]);
      const branch = findKeyTolerantly(item, ["defaultBranch", "branch", "startingBranch"]);
      return {
        name: String(name),
        repo: typeof repo === "string" ? repo : undefined,
        branch: typeof branch === "string" ? branch : undefined,
        raw: item,
      };
    }
    return { name: String(item), raw: item };
  });
}

/**
 * Tolerantly extracts a list of sessions from the API response.
 */
export function extractSessionsList(data: any): ParsedSession[] {
  if (!data) return [];
  let list: any[] = [];

  if (Array.isArray(data)) {
    list = data;
  } else if (typeof data === "object") {
    const candidateArrays = [
      "sessions",
      "items",
      "sessionList",
      "results",
      "data",
    ];
    for (const key of candidateArrays) {
      if (Array.isArray(data[key])) {
        list = data[key];
        break;
      }
    }
    if (list.length === 0) {
      for (const val of Object.values(data)) {
        if (Array.isArray(val)) {
          list = val;
          break;
        }
      }
    }
  }

  return list.map((item) => extractSession(item));
}

/**
 * Tolerantly extracts activity items from response.
 */
export function extractActivities(data: any): ParsedActivity[] {
  if (!data) return [];
  let list: any[] = [];

  if (Array.isArray(data)) {
    list = data;
  } else if (typeof data === "object") {
    const candidateArrays = [
      "activities",
      "events",
      "items",
      "activityList",
      "history",
      "logs",
    ];
    for (const key of candidateArrays) {
      if (Array.isArray(data[key])) {
        list = data[key];
        break;
      }
    }
    if (list.length === 0) {
      for (const val of Object.values(data)) {
        if (Array.isArray(val)) {
          list = val;
          break;
        }
      }
    }
  }

  return list.map((item) => {
    if (!item || typeof item !== "object") {
      return { message: String(item), raw: item };
    }

    const id = findKeyTolerantly(item, ["id", "activityId", "name"]);
    const timestamp = findKeyTolerantly(item, [
      "createTime",
      "create_time",
      "timestamp",
      "time",
      "createdAt",
      "created_at",
    ]);
    const type = findKeyTolerantly(item, [
      "type",
      "activityType",
      "activity_type",
      "kind",
      "event",
      "action",
    ]);
    const message = findKeyTolerantly(item, [
      "description",
      "message",
      "summary",
      "title",
      "detail",
      "content",
      "text",
      "log",
    ]);

    return {
      id: typeof id === "string" ? id : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      timestamp: typeof timestamp === "string" ? timestamp : undefined,
      type: typeof type === "string" ? type : undefined,
      message: typeof message === "string" ? message : undefined,
      details: item,
      raw: item,
    };
  });
}

/**
 * Helper to check if session state is terminal.
 */
export function isTerminalState(state?: string): boolean {
  if (!state) return false;
  const upper = state.toUpperCase();
  return upper === "COMPLETED" || upper === "FAILED" || upper === "CANCELLED" || upper === "SUCCEEDED";
}

/**
 * Helper to check if session state requires user action.
 */
export function isAwaitingUserState(state?: string): boolean {
  if (!state) return false;
  const upper = state.toUpperCase();
  return (
    upper.startsWith("AWAITING_") ||
    upper === "AWAITING_PLAN_APPROVAL" ||
    upper === "AWAITING_USER_FEEDBACK" ||
    upper === "USER_INPUT_REQUIRED"
  );
}
