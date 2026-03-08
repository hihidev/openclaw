import type { OpenClawConfig } from "../config/config.js";
import type { DmScope } from "../config/types.base.js";
import type { ToolProfileId } from "../config/types.tools.js";

export const ONBOARDING_DEFAULT_DM_SCOPE: DmScope = "per-channel-peer";
export const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "messaging";

function seedManagerAgentList(
  baseConfig: OpenClawConfig,
): NonNullable<OpenClawConfig["agents"]>["list"] {
  const existingList = baseConfig.agents?.list;
  if (Array.isArray(existingList) && existingList.length > 0) {
    return existingList;
  }

  return [
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
  ];
}

export function applyManagerPatternDefaults(baseConfig: OpenClawConfig): OpenClawConfig {
  const defaults = baseConfig.agents?.defaults ?? {};
  const subagents = defaults.subagents ?? {};

  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...defaults,
        subagents: {
          ...subagents,
          maxSpawnDepth: subagents.maxSpawnDepth ?? 2,
          maxConcurrent: subagents.maxConcurrent ?? 8,
          maxChildrenPerAgent: subagents.maxChildrenPerAgent ?? 5,
          runTimeoutSeconds: subagents.runTimeoutSeconds ?? 900,
          reviewBeforeDelivery: subagents.reviewBeforeDelivery ?? true,
        },
      },
      list: seedManagerAgentList(baseConfig),
    },
  };
}

export function applyOnboardingLocalWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
): OpenClawConfig {
  const nextConfig = applyManagerPatternDefaults(baseConfig);
  return {
    ...nextConfig,
    agents: {
      ...nextConfig.agents,
      defaults: {
        ...nextConfig.agents?.defaults,
        workspace: workspaceDir,
      },
    },
    gateway: {
      ...nextConfig.gateway,
      mode: "local",
    },
    session: {
      ...nextConfig.session,
      dmScope: nextConfig.session?.dmScope ?? ONBOARDING_DEFAULT_DM_SCOPE,
    },
    tools: {
      ...nextConfig.tools,
      profile: nextConfig.tools?.profile ?? ONBOARDING_DEFAULT_TOOLS_PROFILE,
    },
  };
}
