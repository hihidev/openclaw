import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeTask,
  ensureWorkspaceState,
  loadWorkspaceState,
  parseWorkspaceTaskPacket,
  recordTaskMessage,
  resolveWorkspaceTask,
  switchActiveTask,
} from "./state.js";

const tempDirs = new Set<string>();

async function makeWorkspaceDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-workspace-"));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
  tempDirs.clear();
});

async function createTelegramTask(params: {
  workspaceDir: string;
  sessionId?: string;
  prompt: string;
}) {
  return await resolveWorkspaceTask({
    workspaceDir: params.workspaceDir,
    sessionId: params.sessionId ?? "session-a",
    prompt: params.prompt,
    forceCreateTask: true,
    directTelegram: true,
    internalMessage: false,
  });
}

describe("telegram workspace state", () => {
  it("creates globally unique task ids and resets when the session id changes", async () => {
    const workspaceDir = await makeWorkspaceDir();
    const first = await createTelegramTask({
      workspaceDir,
      prompt: "Review the direct Telegram workspace flow",
    });

    expect(first.task?.taskId).toMatch(/^T-\d{8}-\d{9}-\d{3}$/);

    const second = await ensureWorkspaceState({
      workspaceDir,
      sessionId: "session-b",
    });
    expect(second.workspaceId).not.toBe(first.index.workspaceId);
    expect(second.activeTaskId).toBeUndefined();
    expect(Object.keys(second.tasks)).toHaveLength(0);
  });

  it("resolves replies by bound message id and falls back to the active task", async () => {
    const workspaceDir = await makeWorkspaceDir();
    const first = await createTelegramTask({ workspaceDir, prompt: "Track the first task" });
    expect(first.task).toBeDefined();
    await recordTaskMessage({
      workspaceDir,
      taskId: first.task!.taskId,
      messageId: "501",
    });

    const second = await createTelegramTask({ workspaceDir, prompt: "Track the second task" });
    expect(second.task).toBeDefined();
    await recordTaskMessage({
      workspaceDir,
      taskId: second.task!.taskId,
      messageId: "601",
    });

    const replyResolved = await resolveWorkspaceTask({
      workspaceDir,
      sessionId: "session-a",
      prompt: "Follow up on the first task",
      replyToMessageId: "501",
      directTelegram: true,
      internalMessage: false,
    });
    expect(replyResolved.source).toBe("reply");
    expect(replyResolved.task?.taskId).toBe(first.task!.taskId);

    await switchActiveTask({
      workspaceDir,
      taskId: second.task!.taskId,
    });
    const activeResolved = await resolveWorkspaceTask({
      workspaceDir,
      sessionId: "session-a",
      prompt: "Continue the active task",
      directTelegram: true,
      internalMessage: false,
    });
    expect(activeResolved.source).toBe("active");
    expect(activeResolved.task?.taskId).toBe(second.task!.taskId);
  });

  it("falls back to reply_to_id from the decorated prompt when hook reply metadata is missing", async () => {
    const workspaceDir = await makeWorkspaceDir();
    const first = await createTelegramTask({ workspaceDir, prompt: "Track the first task" });
    expect(first.task).toBeDefined();
    await recordTaskMessage({
      workspaceDir,
      taskId: first.task!.taskId,
      messageId: "501",
    });

    const second = await createTelegramTask({ workspaceDir, prompt: "Track the second task" });
    expect(second.task).toBeDefined();

    const replyResolved = await resolveWorkspaceTask({
      workspaceDir,
      sessionId: "session-a",
      prompt: [
        "## Workspace Task Context (trusted plugin metadata)",
        `ActiveTaskId: ${second.task!.taskId}`,
        "",
        "Conversation info (untrusted metadata):",
        "```json",
        '{ "message_id": "700", "reply_to_id": "501", "has_reply_context": true }',
        "```",
        "",
        "Hi",
      ].join("\n"),
      directTelegram: true,
      internalMessage: false,
    });

    expect(replyResolved.source).toBe("reply");
    expect(replyResolved.task?.taskId).toBe(first.task!.taskId);
  });

  it("falls back to the replied message body task reference when an older bot message was never indexed", async () => {
    const workspaceDir = await makeWorkspaceDir();
    const first = await createTelegramTask({ workspaceDir, prompt: "Track the first task" });
    expect(first.task).toBeDefined();

    const second = await createTelegramTask({ workspaceDir, prompt: "Track the second task" });
    expect(second.task).toBeDefined();

    const suffix = first.task!.taskId.slice(-3);
    const replyResolved = await resolveWorkspaceTask({
      workspaceDir,
      sessionId: "session-a",
      prompt: "Hi",
      metadataPrompt: [
        "## Workspace Task Context (trusted plugin metadata)",
        `ActiveTaskId: ${second.task!.taskId}`,
        "",
        "Conversation info (untrusted metadata):",
        "```json",
        '{ "message_id": "700", "reply_to_id": "7999", "has_reply_context": true }',
        "```",
        "",
        "Replied message (untrusted, for context):",
        "```json",
        `{ "sender_label": "RC_Bot", "body": "Hello there\\n\\nStill in T-${suffix}." }`,
        "```",
        "",
        "Hi",
      ].join("\n"),
      directTelegram: true,
      internalMessage: false,
    });

    expect(replyResolved.source).toBe("reply");
    expect(replyResolved.task?.taskId).toBe(first.task!.taskId);

    const persisted = await loadWorkspaceState(workspaceDir);
    expect(persisted?.messageToTask["7999"]).toBe(first.task!.taskId);
  });

  it("creates a new task after /task arms pending creation even when another task is active", async () => {
    const workspaceDir = await makeWorkspaceDir();
    const first = await createTelegramTask({ workspaceDir, prompt: "Track the first task" });
    const second = await createTelegramTask({ workspaceDir, prompt: "Track the second task" });

    expect(second.source).toBe("created");
    expect(second.task?.taskId).not.toBe(first.task?.taskId);
    expect(second.index.activeTaskId).toBe(second.task?.taskId);
  });

  it("applies trusted internal task packets and clears active state when closed", async () => {
    const workspaceDir = await makeWorkspaceDir();
    const created = await createTelegramTask({
      workspaceDir,
      prompt: "Investigate async callback handling",
    });
    const packet = parseWorkspaceTaskPacket(
      [
        `WorkspaceId: ${created.index.workspaceId}`,
        `TaskId: ${created.task!.taskId}`,
        "Status: completed",
        "Summary: Investigation finished",
        "NextAction: Report back",
        "DelegatedTo: cto",
      ].join("\n"),
    );

    expect(packet).toMatchObject({
      workspaceId: created.index.workspaceId,
      taskId: created.task!.taskId,
      state: "completed",
      summary: "Investigation finished",
      nextAction: "Report back",
      delegatedTo: "cto",
    });

    const updated = await resolveWorkspaceTask({
      workspaceDir,
      sessionId: "session-a",
      prompt: [
        `WorkspaceId: ${created.index.workspaceId}`,
        `TaskId: ${created.task!.taskId}`,
        "Status: completed",
        "Summary: Investigation finished",
        "NextAction: Report back",
        "DelegatedTo: cto",
      ].join("\n"),
      directTelegram: false,
      internalMessage: true,
    });

    expect(updated.source).toBe("callback");
    expect(updated.task?.state).toBe("completed");
    expect(updated.task?.summary).toBe("Investigation finished");
    expect(updated.index.activeTaskId).toBeUndefined();
  });

  it("suppresses stale callback packets from older workspaces", async () => {
    const workspaceDir = await makeWorkspaceDir();
    await createTelegramTask({
      workspaceDir,
      prompt: "Current workspace task",
    });

    const stale = await resolveWorkspaceTask({
      workspaceDir,
      sessionId: "session-b",
      prompt: [
        "WorkspaceId: WS-2026-03-13T21-00-00-000Z",
        "TaskId: T-20260313-210000000-001",
        "Status: completed",
      ].join("\n"),
      directTelegram: false,
      internalMessage: true,
    });

    expect(stale.suppressReply).toBe(true);
    expect(stale.suppressReplyReason).toBe("stale_workspace");
  });

  it("closes the active task deterministically", async () => {
    const workspaceDir = await makeWorkspaceDir();
    const created = await createTelegramTask({
      workspaceDir,
      prompt: "Close this task",
    });

    const closed = await closeTask({
      workspaceDir,
    });

    expect(closed?.taskId).toBe(created.task?.taskId);
    const reloaded = await loadWorkspaceState(workspaceDir);
    expect(reloaded?.tasks[created.task!.taskId]?.state).toBe("closed");
    expect(reloaded?.activeTaskId).toBeUndefined();
  });
});
