import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { __testing as sessionBindingServiceTesting } from "../infra/outbound/session-binding-service.js";
import {
  filterToolsByPolicy,
  isToolAllowedByPolicyName,
  resolveSubagentToolPolicy,
} from "./pi-tools.policy.js";
import { createStubTool } from "./test-helpers/pi-tool-stubs.js";

type AgentCallRequest = { method?: string; params?: Record<string, unknown> };
type RequesterResolution = {
  requesterSessionKey: string;
  requesterOrigin?: Record<string, unknown>;
} | null;

const agentSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
const sendSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "send-main", status: "ok" }));
const sessionsDeleteSpy = vi.fn((_req: AgentCallRequest) => undefined);
const readLatestAssistantReplyMock = vi.fn(
  async (_sessionKey?: string): Promise<string | undefined> => "orchestrator synthesis",
);
const embeddedRunMock = {
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
};
const subagentRegistryMock = {
  isSubagentSessionRunActive: vi.fn(() => true),
  countActiveDescendantRuns: vi.fn((_sessionKey: string) => 0),
  countPendingDescendantRuns: vi.fn((_sessionKey: string) => 0),
  countPendingDescendantRunsExcludingRun: vi.fn((_sessionKey: string, _runId: string) => 0),
  resolveRequesterForChildSession: vi.fn((_sessionKey: string): RequesterResolution => null),
};
const hookRunnerMock = {
  hasHooks: vi.fn((_hookName: string) => false),
  runSubagentDeliveryTarget: vi.fn(async () => undefined),
};
const chatHistoryMock = vi.fn(async (_sessionKey?: string) => ({
  messages: [] as Array<unknown>,
}));
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    defaults: { subagents: { maxSpawnDepth: 2, reviewBeforeDelivery: true } },
    list: [{ id: "main", subagents: { reviewBeforeDelivery: true } }],
  },
};

function loadSessionStoreFixture(): Record<string, Record<string, unknown>> {
  return new Proxy(sessionStore, {
    get(target, key: string | symbol) {
      if (typeof key === "string" && !(key in target) && key.includes(":subagent:")) {
        return { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      }
      return target[key as keyof typeof target];
    },
  });
}

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: { message?: string; sessionKey?: string } };
    if (typed.method === "agent") {
      return await agentSpy(typed);
    }
    if (typed.method === "send") {
      return await sendSpy(typed);
    }
    if (typed.method === "agent.wait") {
      return { status: "error", startedAt: 10, endedAt: 20, error: "boom" };
    }
    if (typed.method === "chat.history") {
      return await chatHistoryMock(typed.params?.sessionKey);
    }
    if (typed.method === "sessions.patch") {
      return {};
    }
    if (typed.method === "sessions.delete") {
      sessionsDeleteSpy(typed);
      return {};
    }
    return {};
  }),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: readLatestAssistantReplyMock,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => loadSessionStoreFixture()),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions.json",
  resolveMainSessionKey: () => "agent:main:main",
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./pi-embedded.js", () => embeddedRunMock);
vi.mock("./subagent-registry.js", () => subagentRegistryMock);
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunnerMock,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

const defaultOutcome = {
  task: "worker task",
  timeoutMs: 10,
  cleanup: "keep" as const,
  waitForCompletion: false,
  startedAt: 10,
  endedAt: 20,
  outcome: { status: "ok" } as const,
};

describe("manager agent 3-tier lifecycle", () => {
  let previousFastTestEnv: string | undefined;
  let runSubagentAnnounceFlow: (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];

  beforeAll(async () => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    ({ runSubagentAnnounceFlow } = await import("./subagent-announce.js"));
  });

  afterAll(() => {
    if (previousFastTestEnv === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
  });

  beforeEach(() => {
    agentSpy
      .mockClear()
      .mockImplementation(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
    sendSpy
      .mockClear()
      .mockImplementation(async (_req: AgentCallRequest) => ({ runId: "send-main", status: "ok" }));
    sessionsDeleteSpy.mockClear().mockImplementation((_req: AgentCallRequest) => undefined);
    embeddedRunMock.isEmbeddedPiRunActive.mockClear().mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockClear().mockReturnValue(false);
    embeddedRunMock.queueEmbeddedPiMessage.mockClear().mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockClear().mockResolvedValue(true);
    subagentRegistryMock.isSubagentSessionRunActive.mockClear().mockReturnValue(true);
    subagentRegistryMock.countActiveDescendantRuns.mockClear().mockReturnValue(0);
    subagentRegistryMock.countPendingDescendantRuns
      .mockClear()
      .mockImplementation((sessionKey: string) =>
        subagentRegistryMock.countActiveDescendantRuns(sessionKey),
      );
    subagentRegistryMock.countPendingDescendantRunsExcludingRun
      .mockClear()
      .mockImplementation((sessionKey: string, _runId: string) =>
        subagentRegistryMock.countPendingDescendantRuns(sessionKey),
      );
    subagentRegistryMock.resolveRequesterForChildSession.mockClear().mockReturnValue(null);
    hookRunnerMock.hasHooks.mockClear();
    hookRunnerMock.runSubagentDeliveryTarget.mockClear();
    readLatestAssistantReplyMock.mockClear().mockResolvedValue("orchestrator synthesis");
    chatHistoryMock.mockReset().mockResolvedValue({ messages: [] });
    sessionStore = {};
    sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: { subagents: { maxSpawnDepth: 2, reviewBeforeDelivery: true } },
        list: [{ id: "main", subagents: { reviewBeforeDelivery: true } }],
      },
    };
  });

  it("full 3-tier lifecycle: orchestrator announce goes to main with review instruction", async () => {
    // Simulate: orchestrator (depth 1) completes and announces to main (depth 0).
    // With reviewBeforeDelivery, main should receive the result for review, not direct send.
    sessionStore = {
      "agent:main:subagent:orchestrator": { sessionId: "orch-1" },
      "agent:main:main": { sessionId: "main-1" },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:orchestrator",
      childRunId: "run-orch-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "telegram", to: "telegram:123", accountId: "acct-1" },
      ...defaultOutcome,
      task: "orchestrate research",
      label: "research-orchestrator",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    // Direct send suppressed by reviewBeforeDelivery
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalled();

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    const message = typeof call?.params?.message === "string" ? call.params.message : "";
    // Review instruction, not directive
    expect(message).toContain("Process this result according to your session instructions");
    expect(message).not.toContain("send that user-facing update now");
    // Internal event contains task info
    expect(message).toContain("task: research-orchestrator");
  });

  it("worker timeout triggers orchestrator review with error status", async () => {
    // Worker (depth 2) times out and announces to orchestrator (depth 1).
    // Inner loop: requesterIsSubagent=true, so always internal.
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:orchestrator:subagent:worker",
      childRunId: "run-worker-timeout",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterOrigin: { channel: "telegram", to: "telegram:123", accountId: "acct-1" },
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      ...defaultOutcome,
      outcome: { status: "timeout" },
      task: "fetch data",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalled();

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    const message = typeof call?.params?.message === "string" ? call.params.message : "";
    expect(message).toContain("timed out");
    // Inner loop instruction for subagent parent
    expect(message).toContain(
      "Convert this completion into a concise internal orchestration update",
    );
    expect(call?.params?.deliver).toBe(false);
  });

  it("reviewBeforeDelivery=false at top level allows direct send (regression)", async () => {
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: { subagents: { maxSpawnDepth: 2, reviewBeforeDelivery: false } },
      },
    };
    sessionStore = {
      "agent:main:subagent:orchestrator": { sessionId: "orch-regression" },
      "agent:main:main": { sessionId: "main-regression" },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "synthesized report" }] }],
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:orchestrator",
      childRunId: "run-orch-regression",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:999", accountId: "acct-reg" },
      ...defaultOutcome,
      task: "orchestrate",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    // Direct send fires when review is off
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("orchestrator tool policy denies work tools", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: {
        subagents: {
          tools: { deny: ["edit", "write", "exec", "apply_patch"] },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);

    // Orchestrator cannot do work
    expect(isToolAllowedByPolicyName("edit", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("write", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("apply_patch", policy)).toBe(false);

    // But can manage
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);

    // Verify filter
    const allTools = [
      createStubTool("read"),
      createStubTool("edit"),
      createStubTool("exec"),
      createStubTool("sessions_spawn"),
      createStubTool("subagents"),
    ];
    const filtered = filterToolsByPolicy(allTools, policy);
    expect(filtered.map((t) => t.name)).toEqual(["read", "sessions_spawn", "subagents"]);
  });
});
