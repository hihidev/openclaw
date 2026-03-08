import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyManagerPatternDefaults,
  applyOnboardingLocalWorkspaceConfig,
  ONBOARDING_DEFAULT_DM_SCOPE,
  ONBOARDING_DEFAULT_TOOLS_PROFILE,
} from "./onboard-config.js";

describe("applyManagerPatternDefaults", () => {
  it("seeds manager subagent defaults and agent routing for empty configs", () => {
    const result = applyManagerPatternDefaults({});

    expect(result.agents?.defaults?.subagents?.maxSpawnDepth).toBe(2);
    expect(result.agents?.defaults?.subagents?.maxConcurrent).toBe(8);
    expect(result.agents?.defaults?.subagents?.maxChildrenPerAgent).toBe(5);
    expect(result.agents?.defaults?.subagents?.runTimeoutSeconds).toBe(900);
    expect(result.agents?.defaults?.subagents?.reviewBeforeDelivery).toBe(true);
    expect(result.agents?.list).toEqual([
      {
        id: "main",
        default: true,
        subagents: {
          allowAgents: ["orchestrator"],
        },
      },
      {
        id: "orchestrator",
        subagents: {
          allowAgents: ["worker"],
        },
        tools: {
          deny: ["edit", "write", "exec", "apply_patch"],
        },
      },
      {
        id: "worker",
      },
    ]);
  });

  it("preserves existing subagent settings and explicit agent list", () => {
    const baseConfig: OpenClawConfig = {
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 1,
            reviewBeforeDelivery: false,
          },
        },
        list: [{ id: "custom", default: true }],
      },
    };

    const result = applyManagerPatternDefaults(baseConfig);

    expect(result.agents?.defaults?.subagents?.maxSpawnDepth).toBe(1);
    expect(result.agents?.defaults?.subagents?.reviewBeforeDelivery).toBe(false);
    expect(result.agents?.list).toEqual([{ id: "custom", default: true }]);
  });
});

describe("applyOnboardingLocalWorkspaceConfig", () => {
  it("sets secure dmScope default when unset", () => {
    const baseConfig: OpenClawConfig = {};
    const result = applyOnboardingLocalWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBe(ONBOARDING_DEFAULT_DM_SCOPE);
    expect(result.gateway?.mode).toBe("local");
    expect(result.agents?.defaults?.workspace).toBe("/tmp/workspace");
    expect(result.agents?.defaults?.subagents?.maxSpawnDepth).toBe(2);
    expect(result.agents?.defaults?.subagents?.reviewBeforeDelivery).toBe(true);
    expect(result.agents?.list?.map((entry) => entry.id)).toEqual([
      "main",
      "orchestrator",
      "worker",
    ]);
    expect(result.tools?.profile).toBe(ONBOARDING_DEFAULT_TOOLS_PROFILE);
  });

  it("preserves existing dmScope when already configured", () => {
    const baseConfig: OpenClawConfig = {
      session: {
        dmScope: "main",
      },
    };
    const result = applyOnboardingLocalWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBe("main");
  });

  it("preserves explicit non-main dmScope values", () => {
    const baseConfig: OpenClawConfig = {
      session: {
        dmScope: "per-account-channel-peer",
      },
    };
    const result = applyOnboardingLocalWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBe("per-account-channel-peer");
  });

  it("preserves an explicit tools.profile when already configured", () => {
    const baseConfig: OpenClawConfig = {
      tools: {
        profile: "full",
      },
    };
    const result = applyOnboardingLocalWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.tools?.profile).toBe("full");
  });
});
