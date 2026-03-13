import fs from "node:fs/promises";
import path from "node:path";

const INDEX_VERSION = 1;
const STATE_DIR = path.join(".openclaw", "task-index");
const INDEX_FILE = "current.json";
const LEDGER_FILE = "TASKS.md";
const SILENT_REPLY_TOKEN = "NO_REPLY";

export type WorkspaceTaskState =
  | "active"
  | "delegated"
  | "waiting"
  | "blocked"
  | "completed"
  | "closed";

export type WorkspaceTaskRecord = {
  workspaceId: string;
  taskId: string;
  title: string;
  state: WorkspaceTaskState;
  createdAt: string;
  updatedAt: string;
  anchorMessageId?: string;
  lastBotMessageId?: string;
  delegatedTo?: string;
  summary?: string;
  nextAction?: string;
};

export type WorkspaceTaskIndex = {
  version: typeof INDEX_VERSION;
  sessionId: string;
  workspaceId: string;
  activeTaskId?: string;
  tasks: Record<string, WorkspaceTaskRecord>;
  messageToTask: Record<string, string>;
  updatedAt: string;
};

export type WorkspaceTaskPacket = {
  workspaceId: string;
  taskId: string;
  state?: WorkspaceTaskState;
  summary?: string;
  nextAction?: string;
  delegatedTo?: string;
  anchorMessageId?: string;
};

export type WorkspaceTaskResolution = {
  index: WorkspaceTaskIndex;
  task?: WorkspaceTaskRecord;
  source: "reply" | "active" | "created" | "callback" | "none";
  prompt: string;
  callbackPacket?: WorkspaceTaskPacket;
  suppressReply?: boolean;
  suppressReplyReason?: string;
};

function resolveIndexPath(workspaceDir: string): string {
  return path.join(workspaceDir, STATE_DIR, INDEX_FILE);
}

function resolveLedgerPath(workspaceDir: string): string {
  return path.join(workspaceDir, LEDGER_FILE);
}

function createWorkspaceId(now = new Date()): string {
  return `WS-${now.toISOString().replace(/[:.]/g, "-")}`;
}

function createEmptyIndex(sessionId: string, now = new Date()): WorkspaceTaskIndex {
  return {
    version: INDEX_VERSION,
    sessionId,
    workspaceId: createWorkspaceId(now),
    tasks: {},
    messageToTask: {},
    updatedAt: now.toISOString(),
  };
}

function toMessageKey(messageId: string | number): string {
  return String(messageId).trim();
}

function createTaskNamespace(workspaceId: string): string {
  const trimmed = workspaceId.trim().replace(/^WS-/i, "");
  const structured = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z?$/i.exec(trimmed);
  if (structured) {
    return `${structured[1]}${structured[2]}${structured[3]}-${structured[4]}${structured[5]}${structured[6]}${structured[7]}`;
  }
  const normalized = trimmed
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "WORKSPACE";
}

function extractTaskSequence(taskId: string): number | null {
  const match = /^T-[A-Z0-9-]+-(\d{3,})$/i.exec(taskId);
  if (!match?.[1]) {
    return null;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function nextTaskId(index: WorkspaceTaskIndex): string {
  let max = 0;
  for (const taskId of Object.keys(index.tasks)) {
    const value = extractTaskSequence(taskId);
    if (value != null) {
      max = Math.max(max, value);
    }
  }
  return `T-${createTaskNamespace(index.workspaceId)}-${String(max + 1).padStart(3, "0")}`;
}

function deriveTaskTitle(input: string): string {
  const firstLine = input.replace(/\s+/g, " ").trim().split("\n")[0]?.trim();
  if (!firstLine) {
    return "Untitled task";
  }
  return firstLine.length > 80 ? `${firstLine.slice(0, 77).trimEnd()}...` : firstLine;
}

function normalizeTaskState(raw?: string): WorkspaceTaskState | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "active":
    case "delegated":
    case "waiting":
    case "blocked":
    case "completed":
    case "closed":
      return normalized;
    case "done":
    case "complete":
      return "completed";
    default:
      return undefined;
  }
}

function normalizePacketKey(raw: string): string {
  return raw.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function normalizeOptionalString(raw?: string): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractReplyToMessageIdFromPrompt(prompt: string): string | undefined {
  // before_prompt_build should receive replyToMessageId directly from the runtime,
  // but some live Telegram reply paths still only expose it inside the generated
  // conversation metadata block. Parse that block as a narrow fallback so reply
  // routing still prefers the replied task over the active task.
  const match = /"reply_to_id"\s*:\s*"([^"]+)"/i.exec(prompt);
  return normalizeOptionalString(match?.[1]);
}

function extractRepliedMessageBodyFromPrompt(prompt: string): string | undefined {
  const match = /Replied message \(untrusted, for context\):\s*```json\s*([\s\S]*?)\s*```/i.exec(
    prompt,
  );
  if (!match?.[1]) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[1]) as { body?: unknown };
    return normalizeOptionalString(typeof parsed.body === "string" ? parsed.body : undefined);
  } catch {
    return undefined;
  }
}

function findTaskIdByReference(index: WorkspaceTaskIndex, reference: string): string | undefined {
  const fullMatch = /\b(T-[A-Z0-9-]+-\d{3,})\b/i.exec(reference);
  if (fullMatch?.[1]) {
    const taskId = normalizeTaskId(fullMatch[1]);
    if (index.tasks[taskId]) {
      return taskId;
    }
  }

  const shortMatch = /\bT-(\d{3,})\b/i.exec(reference);
  if (!shortMatch?.[1]) {
    return undefined;
  }
  const suffix = shortMatch[1].padStart(3, "0");
  const matches = Object.keys(index.tasks).filter((taskId) => taskId.endsWith(`-${suffix}`));
  return matches.length === 1 ? matches[0] : undefined;
}

function renderLedger(index: WorkspaceTaskIndex): string {
  const lines: string[] = [
    "# Workspace Tasks",
    "",
    `- WorkspaceId: ${index.workspaceId}`,
    `- SessionId: ${index.sessionId || "(pending)"}`,
    `- ActiveTaskId: ${index.activeTaskId ?? "(none)"}`,
    "",
  ];
  const tasks = Object.values(index.tasks).toSorted((left, right) =>
    left.taskId.localeCompare(right.taskId, undefined, { numeric: true }),
  );
  if (tasks.length === 0) {
    lines.push("_No open tasks in this workspace._", "");
    return lines.join("\n");
  }
  for (const task of tasks) {
    lines.push(`## ${task.taskId} - ${task.title}`, "");
    lines.push(`- State: ${task.state}`);
    lines.push(`- CreatedAt: ${task.createdAt}`);
    lines.push(`- UpdatedAt: ${task.updatedAt}`);
    if (task.anchorMessageId) {
      lines.push(`- AnchorMessageId: ${task.anchorMessageId}`);
    }
    if (task.lastBotMessageId) {
      lines.push(`- LastBotMessageId: ${task.lastBotMessageId}`);
    }
    if (task.delegatedTo) {
      lines.push(`- DelegatedTo: ${task.delegatedTo}`);
    }
    if (task.summary) {
      lines.push(`- Summary: ${task.summary}`);
    }
    if (task.nextAction) {
      lines.push(`- NextAction: ${task.nextAction}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function persistIndex(workspaceDir: string, index: WorkspaceTaskIndex): Promise<void> {
  const indexPath = resolveIndexPath(workspaceDir);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await fs.writeFile(resolveLedgerPath(workspaceDir), `${renderLedger(index)}\n`, "utf8");
}

function normalizeIndex(raw: unknown): WorkspaceTaskIndex {
  if (!raw || typeof raw !== "object") {
    throw new Error("workspace task index is not an object");
  }
  const parsed = raw as Partial<WorkspaceTaskIndex>;
  if (parsed.version !== INDEX_VERSION) {
    throw new Error(`unsupported workspace task index version: ${String(parsed.version)}`);
  }
  if (typeof parsed.workspaceId !== "string" || !parsed.workspaceId.trim()) {
    throw new Error("workspace task index missing workspaceId");
  }
  return {
    version: INDEX_VERSION,
    sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "",
    workspaceId: parsed.workspaceId.trim(),
    activeTaskId:
      typeof parsed.activeTaskId === "string" && parsed.activeTaskId.trim()
        ? parsed.activeTaskId.trim()
        : undefined,
    tasks: parsed.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {},
    messageToTask:
      parsed.messageToTask && typeof parsed.messageToTask === "object" ? parsed.messageToTask : {},
    updatedAt:
      typeof parsed.updatedAt === "string" && parsed.updatedAt.trim()
        ? parsed.updatedAt
        : new Date().toISOString(),
  };
}

export async function loadWorkspaceState(workspaceDir: string): Promise<WorkspaceTaskIndex | null> {
  try {
    const raw = await fs.readFile(resolveIndexPath(workspaceDir), "utf8");
    return normalizeIndex(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function ensureWorkspaceState(params: {
  workspaceDir: string;
  sessionId: string;
}): Promise<WorkspaceTaskIndex> {
  const existing = await loadWorkspaceState(params.workspaceDir);
  if (existing && existing.sessionId === params.sessionId) {
    return existing;
  }
  const next = createEmptyIndex(params.sessionId);
  await persistIndex(params.workspaceDir, next);
  return next;
}

function setTaskActive(index: WorkspaceTaskIndex, taskId: string | undefined): void {
  index.activeTaskId = taskId;
}

function updateTaskTimestamp(task: WorkspaceTaskRecord): void {
  task.updatedAt = new Date().toISOString();
}

function ensureTaskOpenForUserTurn(task: WorkspaceTaskRecord): void {
  if (task.state === "completed" || task.state === "closed") {
    task.state = "active";
  }
}

function createTask(index: WorkspaceTaskIndex, prompt: string): WorkspaceTaskRecord {
  const now = new Date().toISOString();
  const task: WorkspaceTaskRecord = {
    workspaceId: index.workspaceId,
    taskId: nextTaskId(index),
    title: deriveTaskTitle(prompt),
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
  index.tasks[task.taskId] = task;
  index.activeTaskId = task.taskId;
  index.updatedAt = now;
  return task;
}

function touchTaskForUserTurn(
  task: WorkspaceTaskRecord,
  source?: WorkspaceTaskResolution["source"],
): void {
  ensureTaskOpenForUserTurn(task);
  if (source && source !== "callback") {
    task.state = "active";
  }
  updateTaskTimestamp(task);
}

function normalizeTaskId(raw: string): string {
  return raw.trim().toUpperCase();
}

export function parseWorkspaceTaskPacket(text: string): WorkspaceTaskPacket | null {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9 _-]{1,40}):\s*(.+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    fields.set(normalizePacketKey(match[1]), match[2].trim());
  }
  const workspaceId = normalizeOptionalString(fields.get("workspaceid") ?? fields.get("workspace"));
  const taskId = normalizeOptionalString(fields.get("taskid") ?? fields.get("task"));
  if (!workspaceId || !taskId) {
    return null;
  }
  return {
    workspaceId,
    taskId: normalizeTaskId(taskId),
    state: normalizeTaskState(fields.get("status") ?? fields.get("state")),
    summary: normalizeOptionalString(fields.get("summary")),
    nextAction: normalizeOptionalString(fields.get("nextaction")),
    delegatedTo: normalizeOptionalString(fields.get("delegatedto")),
    anchorMessageId: normalizeOptionalString(
      fields.get("anchormessageid") ?? fields.get("anchorid"),
    ),
  };
}

async function applyTaskPacket(params: {
  workspaceDir: string;
  index: WorkspaceTaskIndex;
  packet: WorkspaceTaskPacket;
}): Promise<WorkspaceTaskRecord | undefined> {
  const task = params.index.tasks[params.packet.taskId];
  if (!task) {
    return undefined;
  }
  if (params.packet.state) {
    task.state = params.packet.state;
  }
  if (params.packet.summary) {
    task.summary = params.packet.summary;
  }
  if (params.packet.nextAction) {
    task.nextAction = params.packet.nextAction;
  }
  if (params.packet.delegatedTo) {
    task.delegatedTo = params.packet.delegatedTo;
  }
  if (params.packet.anchorMessageId) {
    task.anchorMessageId = params.packet.anchorMessageId;
    params.index.messageToTask[params.packet.anchorMessageId] = task.taskId;
  }
  if (params.index.activeTaskId === task.taskId && ["completed", "closed"].includes(task.state)) {
    params.index.activeTaskId = undefined;
  }
  params.index.updatedAt = new Date().toISOString();
  updateTaskTimestamp(task);
  await persistIndex(params.workspaceDir, params.index);
  return task;
}

export function formatTaskList(index: WorkspaceTaskIndex): string {
  const tasks = Object.values(index.tasks).toSorted((left, right) =>
    left.taskId.localeCompare(right.taskId, undefined, { numeric: true }),
  );
  if (tasks.length === 0) {
    return `Workspace ${index.workspaceId} has no tasks yet.`;
  }
  const lines = [`Workspace ${index.workspaceId}`, ""];
  for (const task of tasks) {
    const activeMark = index.activeTaskId === task.taskId ? " [active]" : "";
    lines.push(`- ${task.taskId} · ${task.state}${activeMark} · ${task.title}`);
  }
  return lines.join("\n");
}

export async function switchActiveTask(params: {
  workspaceDir: string;
  taskId: string;
}): Promise<WorkspaceTaskRecord | null> {
  const index = await loadWorkspaceState(params.workspaceDir);
  if (!index) {
    return null;
  }
  const task = index.tasks[normalizeTaskId(params.taskId)];
  if (!task) {
    return null;
  }
  ensureTaskOpenForUserTurn(task);
  setTaskActive(index, task.taskId);
  index.updatedAt = new Date().toISOString();
  updateTaskTimestamp(task);
  await persistIndex(params.workspaceDir, index);
  return task;
}

export async function closeTask(params: {
  workspaceDir: string;
  taskId?: string;
}): Promise<WorkspaceTaskRecord | null> {
  const index = await loadWorkspaceState(params.workspaceDir);
  if (!index) {
    return null;
  }
  const resolvedTaskId = normalizeOptionalString(params.taskId)
    ? normalizeTaskId(params.taskId!)
    : index.activeTaskId;
  if (!resolvedTaskId) {
    return null;
  }
  const task = index.tasks[resolvedTaskId];
  if (!task) {
    return null;
  }
  task.state = "closed";
  updateTaskTimestamp(task);
  if (index.activeTaskId === task.taskId) {
    index.activeTaskId = undefined;
  }
  index.updatedAt = new Date().toISOString();
  await persistIndex(params.workspaceDir, index);
  return task;
}

export async function recordTaskMessage(params: {
  workspaceDir: string;
  taskId: string;
  messageId: string;
}): Promise<void> {
  const index = await loadWorkspaceState(params.workspaceDir);
  if (!index) {
    return;
  }
  const task = index.tasks[normalizeTaskId(params.taskId)];
  if (!task) {
    return;
  }
  if (!task.anchorMessageId) {
    task.anchorMessageId = params.messageId;
  }
  task.lastBotMessageId = params.messageId;
  updateTaskTimestamp(task);
  index.messageToTask[params.messageId] = task.taskId;
  index.updatedAt = new Date().toISOString();
  await persistIndex(params.workspaceDir, index);
}

export async function resolveWorkspaceTask(params: {
  workspaceDir: string;
  sessionId: string;
  prompt: string;
  metadataPrompt?: string;
  replyToMessageId?: string;
  forceCreateTask?: boolean;
  directTelegram: boolean;
  internalMessage: boolean;
}): Promise<WorkspaceTaskResolution> {
  const index = await ensureWorkspaceState({
    workspaceDir: params.workspaceDir,
    sessionId: params.sessionId,
  });
  const trimmedPrompt = params.prompt.trim();
  const metadataPrompt = (params.metadataPrompt ?? params.prompt).trim();
  const callbackPacket = params.internalMessage ? parseWorkspaceTaskPacket(trimmedPrompt) : null;
  if (callbackPacket) {
    if (callbackPacket.workspaceId !== index.workspaceId) {
      return {
        index,
        source: "callback",
        prompt: trimmedPrompt,
        callbackPacket,
        suppressReply: true,
        suppressReplyReason: "stale_workspace",
      };
    }
    const task = await applyTaskPacket({
      workspaceDir: params.workspaceDir,
      index,
      packet: callbackPacket,
    });
    return {
      index,
      task,
      source: "callback",
      prompt: trimmedPrompt,
      callbackPacket,
    };
  }

  const effectivePrompt = trimmedPrompt;
  const replyToMessageId =
    normalizeOptionalString(params.replyToMessageId) ??
    extractReplyToMessageIdFromPrompt(metadataPrompt);
  const repliedMessageBody = extractRepliedMessageBodyFromPrompt(metadataPrompt);
  let task: WorkspaceTaskRecord | undefined;
  let source: WorkspaceTaskResolution["source"] = "none";

  if (params.forceCreateTask && params.directTelegram && effectivePrompt) {
    task = createTask(index, effectivePrompt);
    source = "created";
  }

  if (!task && replyToMessageId) {
    const boundTaskId = index.messageToTask[replyToMessageId];
    if (boundTaskId) {
      task = index.tasks[boundTaskId];
      source = "reply";
    }
  }

  if (!task && replyToMessageId && repliedMessageBody) {
    const repliedTaskId = findTaskIdByReference(index, repliedMessageBody);
    if (repliedTaskId) {
      task = index.tasks[repliedTaskId];
      source = "reply";
      // Repair older workspaces where bot replies existed before message-id
      // indexing was fixed, so future replies to the same Telegram message can
      // route without parsing the untrusted replied-message preview again.
      index.messageToTask[replyToMessageId] = repliedTaskId;
    }
  }

  if (!task && index.activeTaskId) {
    task = index.tasks[index.activeTaskId];
    source = "active";
  }

  if (!task && params.directTelegram && effectivePrompt) {
    task = createTask(index, effectivePrompt);
    source = "created";
  }

  if (task) {
    touchTaskForUserTurn(task, source);
    setTaskActive(index, task.taskId);
    index.updatedAt = new Date().toISOString();
    await persistIndex(params.workspaceDir, index);
  }

  return {
    index,
    task,
    source,
    prompt: effectivePrompt,
  };
}

export function buildWorkspacePromptContext(resolution: WorkspaceTaskResolution): string {
  if (resolution.suppressReply) {
    return [
      "## Workspace Task Context (trusted plugin metadata)",
      "This is an internal callback for an older workspace.",
      `Do not merge it into the current workspace or send a user-facing update.`,
      `Reply with exactly ${SILENT_REPLY_TOKEN}.`,
    ].join("\n");
  }
  const lines = [
    "## Workspace Task Context (trusted plugin metadata)",
    `WorkspaceId: ${resolution.index.workspaceId}`,
    `ActiveTaskId: ${resolution.index.activeTaskId ?? "(none)"}`,
    `ResolutionSource: ${resolution.source}`,
  ];
  if (resolution.task) {
    lines.push(`TaskId: ${resolution.task.taskId}`);
    lines.push(`TaskTitle: ${resolution.task.title}`);
    lines.push(`TaskState: ${resolution.task.state}`);
    if (resolution.task.anchorMessageId) {
      lines.push(`TaskAnchorMessageId: ${resolution.task.anchorMessageId}`);
    }
    if (resolution.task.summary) {
      lines.push(`TaskSummary: ${resolution.task.summary}`);
    }
    if (resolution.task.nextAction) {
      lines.push(`TaskNextAction: ${resolution.task.nextAction}`);
    }
    if (resolution.task.delegatedTo) {
      lines.push(`TaskDelegatedTo: ${resolution.task.delegatedTo}`);
    }
  }
  lines.push("");
  if (resolution.source === "callback") {
    lines.push(
      "This turn is a trusted internal task-status callback, not normal user prose. Use the updated task state above when you reply to the user.",
    );
  } else if (resolution.task) {
    lines.push(
      "This turn belongs to the task above. Keep your response scoped to that task unless the user explicitly starts another one.",
    );
  }
  lines.push(
    "Do not say a task is completed, closed, or absent unless the trusted task state above says so.",
  );
  return lines.join("\n");
}
