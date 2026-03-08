import { describe, expect, it } from "vitest";
import {
  formatAgentInternalEventsForPrompt,
  type AgentTaskCompletionInternalEvent,
} from "./internal-events.js";

function makeEvent(
  overrides?: Partial<AgentTaskCompletionInternalEvent>,
): AgentTaskCompletionInternalEvent {
  return {
    type: "task_completion",
    source: "subagent",
    childSessionKey: "agent:main:subagent:test",
    childSessionId: "sess-1",
    announceType: "subagent task",
    taskLabel: "research",
    status: "ok",
    statusLabel: "completed successfully",
    result: "done",
    replyInstruction: "Reply now.",
    ...overrides,
  };
}

describe("formatTaskCompletionEvent", () => {
  it("includes task_description when label differs from task", () => {
    const event = makeEvent({
      taskLabel: "research",
      taskDescription: "Look up the latest API changes and summarize",
    });
    const output = formatAgentInternalEventsForPrompt([event]);
    expect(output).toContain("task: research");
    expect(output).toContain("task_description: Look up the latest API changes and summarize");
  });

  it("omits task_description when taskLabel === taskDescription", () => {
    const event = makeEvent({
      taskLabel: "research",
      taskDescription: "research",
    });
    const output = formatAgentInternalEventsForPrompt([event]);
    expect(output).toContain("task: research");
    expect(output).not.toContain("task_description:");
  });

  it("omits task_description when no label was set (taskDescription is undefined)", () => {
    const event = makeEvent({
      taskLabel: "do the thing",
      taskDescription: undefined,
    });
    const output = formatAgentInternalEventsForPrompt([event]);
    expect(output).toContain("task: do the thing");
    expect(output).not.toContain("task_description:");
  });
});
