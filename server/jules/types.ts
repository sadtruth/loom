export type SessionState =
  | "QUEUED"
  | "PLANNING"
  | "AWAITING_PLAN_APPROVAL"
  | "IN_PROGRESS"
  | "AWAITING_USER_FEEDBACK"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | string;

export interface SourceContext {
  source?: string;
  githubRepoContext?: {
    startingBranch?: string;
  };
}

export interface CreateSessionOptions {
  prompt: string;
  source?: string;
  branch?: string;
  title?: string;
  plan?: boolean;
  noPr?: boolean;
}

export interface CreateSessionPayload {
  prompt: string;
  sourceContext?: SourceContext;
  automationMode?: "AUTO_CREATE_PR" | string;
  title?: string;
  requirePlanApproval?: boolean;
}

export interface PullRequestInfo {
  url?: string;
  title?: string;
  description?: string;
  branch?: string;
}

export interface ParsedSession {
  id?: string;
  state?: SessionState;
  title?: string;
  prompt?: string;
  createTime?: string;
  updateTime?: string;
  source?: string;
  branch?: string;
  pullRequest?: PullRequestInfo;
  patch?: string;
  raw: any;
}

export interface ParsedActivity {
  id?: string;
  name?: string;
  timestamp?: string;
  type?: string;
  message?: string;
  details?: any;
  raw: any;
}

export interface ParsedSource {
  name: string;
  repo?: string;
  branch?: string;
  raw: any;
}
