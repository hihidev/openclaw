import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  filterToolsByPolicy,
  isToolAllowedByPolicyName,
  resolveEffectiveToolPolicy,
  resolveSubagentToolPolicy,
} from "./pi-tools.policy.js";
import { createStubTool } from "./test-helpers/pi-tool-stubs.js";

describe("pi-tools.policy", () => {
  it("treats * in allow as allow-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { allow: ["*"] });
    expect(filtered.map((tool) => tool.name)).toEqual(["read", "exec"]);
  });

  it("treats * in deny as deny-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { deny: ["*"] });
    expect(filtered).toEqual([]);
  });

  it("supports wildcard allow/deny patterns", () => {
    expect(isToolAllowedByPolicyName("web_fetch", { allow: ["web_*"] })).toBe(true);
    expect(isToolAllowedByPolicyName("web_search", { deny: ["web_*"] })).toBe(false);
  });

  it("keeps apply_patch when exec is allowlisted", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { allow: ["exec"] })).toBe(true);
  });
});

describe("resolveSubagentToolPolicy depth awareness", () => {
  const baseCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
  } as unknown as OpenClawConfig;

  const deepCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 3 } } },
  } as unknown as OpenClawConfig;

  const leafCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 1 } } },
  } as unknown as OpenClawConfig;

  it("applies subagent tools.alsoAllow to re-enable default-denied tools", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { alsoAllow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("cron", policy)).toBe(false);
  });

  it("applies subagent tools.allow to re-enable default-denied tools", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { allow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(true);
  });

  it("merges subagent tools.alsoAllow into tools.allow when both are set", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: {
        subagents: { tools: { allow: ["sessions_spawn"], alsoAllow: ["sessions_send"] } },
      },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(policy.allow).toEqual(["sessions_spawn", "sessions_send"]);
  });

  it("keeps configured deny precedence over allow and alsoAllow", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: {
        subagents: {
          tools: {
            allow: ["sessions_send"],
            alsoAllow: ["sessions_send"],
            deny: ["sessions_send"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(false);
  });

  it("does not create a restrictive allowlist when only alsoAllow is configured", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { alsoAllow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(policy.allow).toBeUndefined();
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows subagents", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_list", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_history", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_history", policy)).toBe(true);
  });

  it("depth-1 orchestrator still denies gateway, cron, memory", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("gateway", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("cron", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("memory_search", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("memory_get", policy)).toBe(false);
  });

  it("depth-2 leaf denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-2 orchestrator (maxSpawnDepth=3) allows sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(deepCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("depth-3 leaf (maxSpawnDepth=3) denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(deepCfg, 3);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-2 leaf allows subagents (for visibility)", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("depth-2 leaf denies sessions_list and sessions_history", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("sessions_history", policy)).toBe(false);
  });

  it("depth-1 leaf (maxSpawnDepth=1) denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(leafCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-1 leaf (maxSpawnDepth=1) denies sessions_list", () => {
    const policy = resolveSubagentToolPolicy(leafCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(false);
  });

  it("defaults to leaf behavior when no depth is provided", () => {
    const policy = resolveSubagentToolPolicy(baseCfg);
    // Default depth=1, maxSpawnDepth=2 → orchestrator
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("defaults to leaf behavior when depth is undefined and maxSpawnDepth is 1", () => {
    const policy = resolveSubagentToolPolicy(leafCfg);
    // Default depth=1, maxSpawnDepth=1 → leaf
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });
});

describe("orchestrator tool enforcement", () => {
  it("orchestrator with deny config denies edit, write, exec", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { deny: ["edit", "write", "exec"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("edit", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("write", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
    // Management tools still allowed
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
  });

  it("filterToolsByPolicy for orchestrator returns only management + read tools", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { deny: ["edit", "write", "exec", "apply_patch"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    const allTools = [
      createStubTool("read"),
      createStubTool("edit"),
      createStubTool("write"),
      createStubTool("exec"),
      createStubTool("apply_patch"),
      createStubTool("sessions_spawn"),
      createStubTool("subagents"),
      createStubTool("sessions_list"),
      createStubTool("sessions_history"),
    ];
    const filtered = filterToolsByPolicy(allTools, policy);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("sessions_spawn");
    expect(names).toContain("subagents");
    expect(names).toContain("sessions_list");
    expect(names).toContain("sessions_history");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write");
    expect(names).not.toContain("exec");
    expect(names).not.toContain("apply_patch");
  });

  it("worker at depth 2 gets work tools but not sessions_spawn", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 2);
    // Workers get work tools
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("edit", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("write", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(true);
    // But cannot spawn further
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("sessions_history", policy)).toBe(false);
  });

  it("per-agent tools.deny on orchestrator strips work tools; default agent workers keep them", () => {
    const cfg = {
      agents: {
        defaults: { subagents: { maxSpawnDepth: 2 } },
        list: [
          {
            id: "orchestrator",
            tools: { deny: ["edit", "write", "exec", "apply_patch"] },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    // Orchestrator agent at depth 1: per-agent deny removes work tools
    const orchPolicy = resolveEffectiveToolPolicy({
      config: cfg,
      agentId: "orchestrator",
    });
    expect(orchPolicy.agentPolicy?.deny).toEqual(["edit", "write", "exec", "apply_patch"]);
    const orchTools = [
      createStubTool("read"),
      createStubTool("edit"),
      createStubTool("write"),
      createStubTool("exec"),
      createStubTool("apply_patch"),
      createStubTool("sessions_spawn"),
      createStubTool("subagents"),
    ];
    const orchFiltered = filterToolsByPolicy(orchTools, orchPolicy.agentPolicy);
    const orchNames = orchFiltered.map((t) => t.name);
    expect(orchNames).toContain("read");
    expect(orchNames).toContain("sessions_spawn");
    expect(orchNames).toContain("subagents");
    expect(orchNames).not.toContain("edit");
    expect(orchNames).not.toContain("write");
    expect(orchNames).not.toContain("exec");
    expect(orchNames).not.toContain("apply_patch");

    // Worker under default agent at depth 2: no per-agent deny, keeps work tools
    const workerPolicy = resolveEffectiveToolPolicy({
      config: cfg,
      agentId: "main",
    });
    expect(workerPolicy.agentPolicy).toBeUndefined();
    const workerTools = [
      createStubTool("read"),
      createStubTool("edit"),
      createStubTool("write"),
      createStubTool("exec"),
      createStubTool("apply_patch"),
    ];
    const workerFiltered = filterToolsByPolicy(workerTools, workerPolicy.agentPolicy);
    const workerNames = workerFiltered.map((t) => t.name);
    expect(workerNames).toContain("read");
    expect(workerNames).toContain("edit");
    expect(workerNames).toContain("write");
    expect(workerNames).toContain("exec");
    expect(workerNames).toContain("apply_patch");
  });
});
