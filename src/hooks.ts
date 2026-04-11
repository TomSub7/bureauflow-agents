/**
 * BureauFlow Agent Suite — Hook Callbacks
 *
 * Shared hooks that make all agents smarter:
 * 1. PreToolUse — Log invocations, auto-approve known-safe tools
 * 2. PostToolUse — Track execution time, catch errors, accumulate metrics
 * 3. Stop — Generate a structured summary report when the agent finishes
 *
 * Usage:
 *   import { createAgentHooks, getMetrics, resetMetrics } from "./hooks.js";
 *   const hooks = createAgentHooks("support-agent");
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

// ─── Metrics Accumulator ────────────────────────────────────────────

export interface ToolMetrics {
  toolName: string;
  startedAt: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface AgentMetrics {
  agentName: string;
  startedAt: number;
  toolCalls: ToolMetrics[];
  totalToolCalls: number;
  totalErrors: number;
  totalDurationMs: number;
}

// Per-agent metrics store, keyed by agent name
const metricsStore = new Map<string, AgentMetrics>();

/**
 * Get the current metrics for an agent. Returns undefined if no metrics exist.
 */
export function getMetrics(agentName: string): AgentMetrics | undefined {
  return metricsStore.get(agentName);
}

/**
 * Reset metrics for an agent (call before each run).
 */
export function resetMetrics(agentName: string): void {
  metricsStore.set(agentName, {
    agentName,
    startedAt: Date.now(),
    toolCalls: [],
    totalToolCalls: 0,
    totalErrors: 0,
    totalDurationMs: 0,
  });
}

// ─── Known-Safe Tools ───────────────────────────────────────────────
// These tools are always auto-approved — they read data but never mutate.

const SAFE_TOOLS = new Set([
  "lookup_faq",
  "classify_email",
  "check_subscription",
  "check_recent_signups",
  "score_lead",
  "draft_follow_up",
  "report_cleanup",
  "health_check",
]);

// In-flight tracking: tool_use_id -> start timestamp
const inflightTimers = new Map<string, number>();

// ─── PreToolUse Hook ────────────────────────────────────────────────

function createPreToolUseHook(agentName: string): HookCallback {
  return async (input: HookInput): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") {
      return { continue: true };
    }

    const { tool_name, tool_use_id } = input;
    const timestamp = new Date().toISOString();

    // Log every tool invocation
    console.log(
      `[${agentName}] [${timestamp}] PreToolUse: ${tool_name} (id: ${tool_use_id})`
    );

    // Record start time for duration tracking
    inflightTimers.set(tool_use_id, Date.now());

    // Auto-approve known-safe tools
    if (SAFE_TOOLS.has(tool_name)) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "allow" as const,
          permissionDecisionReason: `Auto-approved: ${tool_name} is a known-safe read-only tool`,
        },
      };
    }

    // For unknown tools, defer to default permission handling
    return { continue: true };
  };
}

// ─── PostToolUse Hook ───────────────────────────────────────────────

function createPostToolUseHook(agentName: string): HookCallback {
  return async (input: HookInput): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== "PostToolUse") {
      return { continue: true };
    }

    const { tool_name, tool_use_id } = input;
    const timestamp = new Date().toISOString();

    // Calculate execution duration
    const startTime = inflightTimers.get(tool_use_id);
    const durationMs = startTime ? Date.now() - startTime : 0;
    inflightTimers.delete(tool_use_id);

    // Log completion
    console.log(
      `[${agentName}] [${timestamp}] PostToolUse: ${tool_name} completed in ${durationMs}ms`
    );

    // Accumulate metrics
    const metrics = metricsStore.get(agentName);
    if (metrics) {
      const toolMetric: ToolMetrics = {
        toolName: tool_name,
        startedAt: startTime ?? Date.now(),
        durationMs,
        success: true,
      };
      metrics.toolCalls.push(toolMetric);
      metrics.totalToolCalls++;
      metrics.totalDurationMs += durationMs;
    }

    return { continue: true };
  };
}

// ─── PostToolUseFailure Hook ────────────────────────────────────────

function createPostToolUseFailureHook(agentName: string): HookCallback {
  return async (input: HookInput): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== "PostToolUseFailure") {
      return { continue: true };
    }

    const { tool_name, tool_use_id, error } = input;
    const timestamp = new Date().toISOString();

    // Calculate execution duration
    const startTime = inflightTimers.get(tool_use_id);
    const durationMs = startTime ? Date.now() - startTime : 0;
    inflightTimers.delete(tool_use_id);

    // Log error
    console.error(
      `[${agentName}] [${timestamp}] TOOL ERROR: ${tool_name} failed after ${durationMs}ms — ${error}`
    );

    // Accumulate error metrics
    const metrics = metricsStore.get(agentName);
    if (metrics) {
      const toolMetric: ToolMetrics = {
        toolName: tool_name,
        startedAt: startTime ?? Date.now(),
        durationMs,
        success: false,
        error,
      };
      metrics.toolCalls.push(toolMetric);
      metrics.totalToolCalls++;
      metrics.totalErrors++;
      metrics.totalDurationMs += durationMs;
    }

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure" as const,
        additionalContext: `Tool ${tool_name} failed: ${error}. Consider retrying or using an alternative approach.`,
      },
    };
  };
}

// ─── Stop Hook ──────────────────────────────────────────────────────

function createStopHook(agentName: string): HookCallback {
  return async (input: HookInput): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== "Stop") {
      return { continue: true };
    }

    const metrics = metricsStore.get(agentName);
    const timestamp = new Date().toISOString();
    const totalRuntime = metrics ? Date.now() - metrics.startedAt : 0;

    // Build structured summary report
    const summary = {
      agent: agentName,
      completedAt: timestamp,
      totalRuntimeMs: totalRuntime,
      toolCalls: metrics?.totalToolCalls ?? 0,
      toolErrors: metrics?.totalErrors ?? 0,
      totalToolDurationMs: metrics?.totalDurationMs ?? 0,
      toolBreakdown: (metrics?.toolCalls ?? []).reduce<
        Record<string, { calls: number; errors: number; totalMs: number }>
      >((acc, t) => {
        const existing = acc[t.toolName] ?? { calls: 0, errors: 0, totalMs: 0 };
        existing.calls++;
        if (!t.success) existing.errors++;
        existing.totalMs += t.durationMs;
        acc[t.toolName] = existing;
        return acc;
      }, {}),
      lastMessage: input.last_assistant_message
        ? input.last_assistant_message.substring(0, 200)
        : undefined,
    };

    // Print the report
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  Agent Summary Report: ${agentName}`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  Completed:      ${summary.completedAt}`);
    console.log(`  Total runtime:  ${summary.totalRuntimeMs}ms`);
    console.log(`  Tool calls:     ${summary.toolCalls}`);
    console.log(`  Tool errors:    ${summary.toolErrors}`);
    console.log(`  Tool time:      ${summary.totalToolDurationMs}ms`);

    const breakdown = summary.toolBreakdown;
    if (Object.keys(breakdown).length > 0) {
      console.log(`  ---`);
      for (const [name, stats] of Object.entries(breakdown)) {
        console.log(
          `  ${name}: ${stats.calls} calls, ${stats.errors} errors, ${stats.totalMs}ms`
        );
      }
    }

    console.log(`${"=".repeat(60)}\n`);

    return { continue: true };
  };
}

// ─── Factory: Create All Hooks for an Agent ─────────────────────────

/**
 * Creates the full set of hook callbacks for a BureauFlow agent.
 * Call `resetMetrics(agentName)` before starting the agent to get a clean run.
 *
 * @param agentName - Identifier for the agent (used in logs and metrics)
 * @returns Hook configuration ready to spread into query options
 */
export function createAgentHooks(
  agentName: string
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  // Initialize metrics for this agent
  resetMetrics(agentName);

  return {
    PreToolUse: [
      {
        hooks: [createPreToolUseHook(agentName)],
      },
    ],
    PostToolUse: [
      {
        hooks: [createPostToolUseHook(agentName)],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [createPostToolUseFailureHook(agentName)],
      },
    ],
    Stop: [
      {
        hooks: [createStopHook(agentName)],
      },
    ],
  };
}
