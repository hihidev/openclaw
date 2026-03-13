import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { loadWorkspaceState } from "./state.js";

const tempDirs = new Set<string>();

async function makeWorkspaceDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-workspace-plugin-"));
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

describe("telegram workspace plugin", () => {
  function registerPlugin() {
    const registerCommand = vi.fn();
    const on = vi.fn();

    plugin.register?.({
      id: "telegram-workspace",
      name: "Telegram Workspace",
      description: "Telegram Workspace",
      source: "test",
      config: {},
      runtime: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      registerTool() {},
      registerHook() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand,
      resolvePath(input: string) {
        return input;
      },
      on,
    });

    return {
      registerCommand,
      on,
      taskCommand: registerCommand.mock.calls.find((call) => call[0].name === "task")?.[0],
      beforePromptBuild: on.mock.calls.find((call) => call[0] === "before_prompt_build")?.[1],
      messageSent: on.mock.calls.find((call) => call[0] === "message_sent")?.[1],
    };
  }

  it("registers commands and hooks", () => {
    const { registerCommand, on } = registerPlugin();

    expect(registerCommand.mock.calls.map((call) => call[0].name)).toEqual([
      "task",
      "list",
      "switch",
      "close",
    ]);
    expect(on.mock.calls.map((call) => call[0])).toEqual([
      "before_prompt_build",
      "before_reset",
      "message_sent",
    ]);
  });

  it("arms /task and binds Telegram task replies through before_prompt_build and message_sent", async () => {
    const { taskCommand, beforePromptBuild, messageSent } = registerPlugin();
    expect(taskCommand?.handler).toBeTypeOf("function");
    expect(beforePromptBuild).toBeTypeOf("function");
    expect(messageSent).toBeTypeOf("function");

    const workspaceDir = await makeWorkspaceDir();
    await taskCommand?.handler({
      channel: "telegram",
      channelId: "telegram",
      isAuthorizedSender: true,
      commandBody: "/task",
      config: {},
      sessionKey: "agent:cos:main",
    });
    await beforePromptBuild(
      { prompt: "Review the plugin split", messages: [] },
      {
        agentId: "cos",
        channelId: "telegram",
        sessionKey: "agent:cos:main",
        sessionId: "session-a",
        workspaceDir,
        commandBody: "Review the plugin split",
      },
    );

    await messageSent(
      { to: "telegram:owner", content: "Reviewing now", success: true, messageId: "7001" },
      {
        channelId: "telegram",
        sessionKey: "agent:cos:main",
      },
    );

    const state = await loadWorkspaceState(workspaceDir);
    expect(state?.messageToTask["7001"]).toBe(state?.activeTaskId);
  });

  it("creates a new task on the next message after bare /task", async () => {
    const { taskCommand, beforePromptBuild } = registerPlugin();
    expect(taskCommand?.handler).toBeTypeOf("function");
    expect(beforePromptBuild).toBeTypeOf("function");

    const workspaceDir = await makeWorkspaceDir();
    const taskResult = await taskCommand?.handler({
      channel: "telegram",
      channelId: "telegram",
      isAuthorizedSender: true,
      commandBody: "/task",
      config: {},
      sessionKey: "agent:cos:main",
    });
    const result = await beforePromptBuild(
      {
        prompt: [
          "Conversation info (untrusted metadata):",
          "```json",
          '{ "message_id": "999" }',
          "```",
          "",
          "say hello world",
        ].join("\n"),
        messages: [],
      },
      {
        agentId: "cos",
        channelId: "telegram",
        sessionKey: "agent:cos:main",
        sessionId: "session-a",
        workspaceDir,
        commandBody: "say hello world",
      },
    );

    const state = await loadWorkspaceState(workspaceDir);
    expect(taskResult?.text).toContain("New task armed");
    expect(state?.activeTaskId).toBeDefined();
    expect(result?.prependContext).toContain("ResolutionSource: created");
    expect(result?.prependContext).toContain("TaskTitle: say hello world");
  });

  it("uses reply_to_id from decorated prompt metadata when hook reply context is missing", async () => {
    const { taskCommand, beforePromptBuild, messageSent } = registerPlugin();
    expect(taskCommand?.handler).toBeTypeOf("function");
    expect(beforePromptBuild).toBeTypeOf("function");
    expect(messageSent).toBeTypeOf("function");

    const workspaceDir = await makeWorkspaceDir();
    await taskCommand?.handler({
      channel: "telegram",
      channelId: "telegram",
      isAuthorizedSender: true,
      commandBody: "/task",
      config: {},
      sessionKey: "agent:cos:main",
    });

    await beforePromptBuild(
      { prompt: "First task", messages: [] },
      {
        agentId: "cos",
        channelId: "telegram",
        sessionKey: "agent:cos:main",
        sessionId: "session-a",
        workspaceDir,
        commandBody: "First task",
      },
    );
    await messageSent(
      { to: "telegram:owner", content: "First task", success: true, messageId: "7001" },
      {
        channelId: "telegram",
        sessionKey: "agent:cos:main",
      },
    );

    await taskCommand?.handler({
      channel: "telegram",
      channelId: "telegram",
      isAuthorizedSender: true,
      commandBody: "/task",
      config: {},
      sessionKey: "agent:cos:main",
    });
    const second = await beforePromptBuild(
      { prompt: "Second task", messages: [] },
      {
        agentId: "cos",
        channelId: "telegram",
        sessionKey: "agent:cos:main",
        sessionId: "session-a",
        workspaceDir,
        commandBody: "Second task",
      },
    );
    expect(second?.prependContext).toContain("ResolutionSource: created");

    const reply = await beforePromptBuild(
      {
        prompt: [
          "## Workspace Task Context (trusted plugin metadata)",
          "ActiveTaskId: T-ignored",
          "",
          "Conversation info (untrusted metadata):",
          "```json",
          '{ "message_id": "7002", "reply_to_id": "7001", "has_reply_context": true }',
          "```",
          "",
          "Hi",
        ].join("\n"),
        messages: [],
      },
      {
        agentId: "cos",
        channelId: "telegram",
        sessionKey: "agent:cos:main",
        sessionId: "session-a",
        workspaceDir,
        commandBody: "Hi",
      },
    );

    expect(reply?.prependContext).toContain("ResolutionSource: reply");
    expect(reply?.prependContext).toContain("TaskTitle: First task");
  });

  it("uses the replied message task label when an older Telegram bot message was never indexed", async () => {
    const { taskCommand, beforePromptBuild } = registerPlugin();
    expect(taskCommand?.handler).toBeTypeOf("function");
    expect(beforePromptBuild).toBeTypeOf("function");

    const workspaceDir = await makeWorkspaceDir();
    await taskCommand?.handler({
      channel: "telegram",
      channelId: "telegram",
      isAuthorizedSender: true,
      commandBody: "/task",
      config: {},
      sessionKey: "agent:cos:main",
    });
    const first = await beforePromptBuild(
      { prompt: "First task", messages: [] },
      {
        agentId: "cos",
        channelId: "telegram",
        sessionKey: "agent:cos:main",
        sessionId: "session-a",
        workspaceDir,
        commandBody: "First task",
      },
    );
    expect(first?.prependContext).toContain("TaskId: T-");

    const firstState = await loadWorkspaceState(workspaceDir);
    const firstTaskId = firstState?.activeTaskId;
    expect(firstTaskId).toBeDefined();

    await taskCommand?.handler({
      channel: "telegram",
      channelId: "telegram",
      isAuthorizedSender: true,
      commandBody: "/task",
      config: {},
      sessionKey: "agent:cos:main",
    });
    await beforePromptBuild(
      { prompt: "Second task", messages: [] },
      {
        agentId: "cos",
        channelId: "telegram",
        sessionKey: "agent:cos:main",
        sessionId: "session-a",
        workspaceDir,
        commandBody: "Second task",
      },
    );

    const suffix = firstTaskId!.slice(-3);
    const reply = await beforePromptBuild(
      {
        prompt: [
          "## Workspace Task Context (trusted plugin metadata)",
          "ActiveTaskId: T-ignored",
          "",
          "Conversation info (untrusted metadata):",
          "```json",
          '{ "message_id": "7002", "reply_to_id": "7999", "has_reply_context": true }',
          "```",
          "",
          "Replied message (untrusted, for context):",
          "```json",
          `{ "sender_label": "RC_Bot", "body": "Hello there\\n\\nStill in T-${suffix}." }`,
          "```",
          "",
          "Hi",
        ].join("\n"),
        messages: [],
      },
      {
        agentId: "cos",
        channelId: "telegram",
        sessionKey: "agent:cos:main",
        sessionId: "session-a",
        workspaceDir,
        commandBody: "Hi",
      },
    );

    expect(reply?.prependContext).toContain("ResolutionSource: reply");
    expect(reply?.prependContext).toContain(`TaskId: ${firstTaskId}`);

    const updatedState = await loadWorkspaceState(workspaceDir);
    expect(updatedState?.messageToTask["7999"]).toBe(firstTaskId);
  });
});
