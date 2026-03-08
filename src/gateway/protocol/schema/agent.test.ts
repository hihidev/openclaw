import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { AgentParamsSchema } from "./agent.js";

describe("AgentParamsSchema", () => {
  it("accepts internal task completion events with taskDescription", () => {
    const ok = Value.Check(AgentParamsSchema, {
      message: "internal event delivery",
      idempotencyKey: "test-key",
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:abc",
          childSessionId: "sess-123",
          announceType: "subagent task",
          taskLabel: "research",
          taskDescription: "Look up the version and summarize it",
          status: "ok",
          statusLabel: "completed successfully",
          result: "2026.3.2",
          replyInstruction: "Process the result.",
        },
      ],
    });

    expect(ok).toBe(true);
  });
});
