import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../src/agents/agent-scope.js";
import {
  buildWorkspacePromptContext,
  closeTask,
  formatTaskList,
  loadWorkspaceState,
  recordTaskMessage,
  resolveWorkspaceTask,
  switchActiveTask,
} from "./state.js";

const TARGET_AGENT_ID = "cos";
const SUPPORTED_CHANNELS = new Set(["telegram", "webchat"]);

type SessionTaskBinding = {
  taskId: string;
  workspaceDir: string;
};

type ScopedContext = {
  agentId?: string;
  channelId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  commandBody?: string;
  replyToMessageId?: string;
};

const sessionTaskBindings = new Map<string, SessionTaskBinding>();
const pendingTaskCreationSessions = new Set<string>();

function isManagedScope(ctx: ScopedContext): ctx is ScopedContext & {
  agentId: string;
  channelId: string;
  sessionKey: string;
  sessionId: string;
  workspaceDir: string;
} {
  return (
    ctx.agentId === TARGET_AGENT_ID &&
    typeof ctx.channelId === "string" &&
    SUPPORTED_CHANNELS.has(ctx.channelId) &&
    typeof ctx.sessionKey === "string" &&
    ctx.sessionKey.trim().length > 0 &&
    typeof ctx.sessionId === "string" &&
    ctx.sessionId.trim().length > 0 &&
    typeof ctx.workspaceDir === "string" &&
    ctx.workspaceDir.trim().length > 0
  );
}

function isManagedCommandScope(ctx: ScopedContext): ctx is ScopedContext & {
  channelId: string;
  sessionKey: string;
} {
  return (
    ctx.channelId === "telegram" &&
    typeof ctx.sessionKey === "string" &&
    ctx.sessionKey.trim().length > 0
  );
}

function resolveManagedCommandScope(
  api: OpenClawPluginApi,
  ctx: ScopedContext,
): {
  sessionKey: string;
  workspaceDir: string;
} | null {
  if (!isManagedCommandScope(ctx)) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: ctx.sessionKey,
    config: api.config,
  });
  if (agentId !== TARGET_AGENT_ID) {
    return null;
  }
  const workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
  if (!workspaceDir) {
    return null;
  }
  return {
    sessionKey: ctx.sessionKey,
    workspaceDir,
  };
}

function clearSessionBinding(sessionKey?: string): void {
  if (!sessionKey) {
    return;
  }
  sessionTaskBindings.delete(sessionKey);
  pendingTaskCreationSessions.delete(sessionKey);
}

function setSessionBinding(params: {
  sessionKey: string;
  workspaceDir: string;
  taskId: string;
}): void {
  sessionTaskBindings.set(params.sessionKey, {
    workspaceDir: params.workspaceDir,
    taskId: params.taskId,
  });
}

function unavailableCommandResult() {
  return {
    text: "This command is only available in the direct Telegram HQ chat handled by `cos`.",
  };
}

export default {
  id: "telegram-workspace",
  name: "Telegram Workspace",
  description: "One-DM workspace/task routing for direct Telegram conversations with cos.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerCommand({
      name: "task",
      description: "Start a new task in the current workspace.",
      acceptsArgs: false,
      handler: async (ctx) => {
        clearSessionBinding(ctx.sessionKey);
        const scope = resolveManagedCommandScope(api, ctx);
        if (!scope) {
          return unavailableCommandResult();
        }
        pendingTaskCreationSessions.add(scope.sessionKey);
        return {
          text: "New task armed. Send the task request in your next message.",
        };
      },
    });

    api.registerCommand({
      name: "list",
      description: "List tasks in the current Telegram workspace.",
      acceptsArgs: false,
      handler: async (ctx) => {
        clearSessionBinding(ctx.sessionKey);
        const scope = resolveManagedCommandScope(api, ctx);
        if (!scope) {
          return unavailableCommandResult();
        }
        const index = await loadWorkspaceState(scope.workspaceDir);
        return { text: index ? formatTaskList(index) : "This workspace has no tasks yet." };
      },
    });

    api.registerCommand({
      name: "switch",
      description: "Switch the active Telegram workspace task.",
      acceptsArgs: true,
      handler: async (ctx) => {
        clearSessionBinding(ctx.sessionKey);
        const scope = resolveManagedCommandScope(api, ctx);
        if (!scope) {
          return unavailableCommandResult();
        }
        const taskId = ctx.args?.trim();
        if (!taskId) {
          return { text: "Usage: /switch <TaskId>" };
        }
        const task = await switchActiveTask({
          workspaceDir: scope.workspaceDir,
          taskId,
        });
        if (!task) {
          return { text: `Task not found: ${taskId}` };
        }
        return { text: `Switched to ${task.taskId} · ${task.title}` };
      },
    });

    api.registerCommand({
      name: "close",
      description: "Close the current Telegram workspace task or a specified task id.",
      acceptsArgs: true,
      handler: async (ctx) => {
        clearSessionBinding(ctx.sessionKey);
        const scope = resolveManagedCommandScope(api, ctx);
        if (!scope) {
          return unavailableCommandResult();
        }
        const task = await closeTask({
          workspaceDir: scope.workspaceDir,
          taskId: ctx.args?.trim() || undefined,
        });
        if (!task) {
          return {
            text: "No task was closed. Use /close <TaskId> or make sure an active task exists.",
          };
        }
        return { text: `Closed ${task.taskId} · ${task.title}` };
      },
    });

    api.on("before_prompt_build", async (event, ctx) => {
      if (!isManagedScope(ctx)) {
        return;
      }
      const resolution = await resolveWorkspaceTask({
        workspaceDir: ctx.workspaceDir,
        sessionId: ctx.sessionId,
        prompt: ctx.commandBody?.trim() || event.prompt,
        metadataPrompt: event.prompt,
        replyToMessageId: ctx.replyToMessageId,
        forceCreateTask: pendingTaskCreationSessions.has(ctx.sessionKey),
        directTelegram: ctx.channelId === "telegram",
        internalMessage: ctx.channelId === "webchat",
      });
      pendingTaskCreationSessions.delete(ctx.sessionKey);
      if (resolution.task) {
        setSessionBinding({
          sessionKey: ctx.sessionKey,
          workspaceDir: ctx.workspaceDir,
          taskId: resolution.task.taskId,
        });
      } else {
        clearSessionBinding(ctx.sessionKey);
      }
      const prependContext = buildWorkspacePromptContext(resolution);
      return prependContext ? { prependContext } : undefined;
    });

    api.on("before_reset", async (_event, ctx) => {
      clearSessionBinding(ctx.sessionKey);
    });

    api.on("message_sent", async (event, ctx) => {
      if (ctx.channelId !== "telegram" || !ctx.sessionKey || !event.success || !event.messageId) {
        return;
      }
      const binding = sessionTaskBindings.get(ctx.sessionKey);
      if (!binding) {
        return;
      }
      await recordTaskMessage({
        workspaceDir: binding.workspaceDir,
        taskId: binding.taskId,
        messageId: event.messageId,
      });
    });
  },
};
