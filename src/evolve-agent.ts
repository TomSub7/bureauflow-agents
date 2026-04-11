/**
 * BureauFlow Evolution Agent — Continuous Improvement Engine
 *
 * The "improvement engineer" that analyzes all other agents and suggests
 * data-driven improvements. Reads metrics from hooks.ts, inspects agent
 * prompts, checks for stale data, and produces actionable improvement reports.
 *
 * Tools:
 * - analyze_agent_performance — Identify slow, error-prone, or underused tools
 * - suggest_prompt_improvements — Analyze system prompts for gaps and inconsistencies
 * - generate_improvement_report — Structured markdown report with health scores
 * - auto_update_task_history — Sync completed-tasks.json with recent activity
 * - check_for_stale_data — Detect outdated hardcoded values across agents
 *
 * Usage: npx tsx src/evolve-agent.ts
 *        npx tsx src/evolve-agent.ts "Analyze support-agent and suggest improvements"
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL,
  BUREAUFLOW_CONTEXT,
  OPS_EMAIL,
  CEO_EMAIL,
  DEMO_PHONE,
  DEFAULT_MAX_TURNS,
} from "./config.js";
import { getMetrics, type AgentMetrics } from "./hooks.js";
import { CRON_JOBS, WEBHOOKS } from "./automation-map.js";

// ─── File Paths ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = resolve(__dirname, "..", "data");
const TASKS_PATH = resolve(DATA_DIR, "completed-tasks.json");
const REPORT_PATH = resolve(DATA_DIR, "evolution-report.json");

// ─── Known Agents Registry ─────────────────────────────────────────

interface AgentEntry {
  name: string;
  file: string;
  description: string;
  expectedTools: string[];
}

const KNOWN_AGENTS: AgentEntry[] = [
  {
    name: "support-agent",
    file: "support-agent.ts",
    description: "Customer support for German tradespeople",
    expectedTools: ["lookup_faq", "check_subscription", "draft_follow_up"],
  },
  {
    name: "email-agent",
    file: "email-agent.ts",
    description: "Inbox cleanup automation",
    expectedTools: ["classify_email", "report_cleanup"],
  },
  {
    name: "lead-agent",
    file: "lead-agent.ts",
    description: "Signup qualification and follow-up",
    expectedTools: ["check_recent_signups", "score_lead", "draft_follow_up"],
  },
  {
    name: "ops-agent",
    file: "ops-agent.ts",
    description: "Operations management and task routing",
    expectedTools: ["health_check"],
  },
  {
    name: "monitor-agent",
    file: "monitor-agent.ts",
    description: "Infrastructure supervisor and health checks",
    expectedTools: ["health_check"],
  },
  {
    name: "dedup-agent",
    file: "dedup-agent.ts",
    description: "Redundancy detection and task history",
    expectedTools: ["check_if_done", "mark_as_done", "list_completed", "find_redundancies"],
  },
];

// ─── Performance Thresholds ────────────────────────────────────────

const SLOW_TOOL_THRESHOLD_MS = 5000;
const HIGH_ERROR_RATE_THRESHOLD = 0.1; // 10%

// ─── Types ─────────────────────────────────────────────────────────

interface ToolAnalysis {
  toolName: string;
  totalCalls: number;
  totalErrors: number;
  errorRate: number;
  avgDurationMs: number;
  maxDurationMs: number;
  isSlow: boolean;
  isHighError: boolean;
}

interface AgentPerformance {
  agentName: string;
  hasMetrics: boolean;
  totalToolCalls: number;
  totalErrors: number;
  overallErrorRate: number;
  totalDurationMs: number;
  toolAnalysis: ToolAnalysis[];
  slowTools: string[];
  highErrorTools: string[];
  underusedTools: string[];
  healthScore: number;
}

interface ImprovementSuggestion {
  priority: "P0" | "P1" | "P2";
  category: "performance" | "prompt" | "tools" | "data" | "guardrails";
  agent: string;
  description: string;
  expectedImpact: string;
  suggestedAction: string;
}

interface EvolutionReport {
  generatedAt: string;
  agentPerformances: AgentPerformance[];
  suggestions: ImprovementSuggestion[];
  staleDataFindings: string[];
  overallHealthScore: number;
}

// ─── Analysis Helpers ──────────────────────────────────────────────

function analyzeAgentMetrics(agentName: string): AgentPerformance {
  const metrics = getMetrics(agentName);
  const agentEntry = KNOWN_AGENTS.find((a) => a.name === agentName);

  if (!metrics || metrics.totalToolCalls === 0) {
    return {
      agentName,
      hasMetrics: false,
      totalToolCalls: 0,
      totalErrors: 0,
      overallErrorRate: 0,
      totalDurationMs: 0,
      toolAnalysis: [],
      slowTools: [],
      highErrorTools: [],
      underusedTools: agentEntry?.expectedTools ?? [],
      healthScore: 50, // Unknown = neutral score
    };
  }

  // Group tool calls by name
  const toolGroups = new Map<
    string,
    { calls: number; errors: number; totalMs: number; maxMs: number }
  >();

  for (const tc of metrics.toolCalls) {
    const existing = toolGroups.get(tc.toolName) ?? {
      calls: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
    };
    existing.calls++;
    if (!tc.success) existing.errors++;
    existing.totalMs += tc.durationMs;
    existing.maxMs = Math.max(existing.maxMs, tc.durationMs);
    toolGroups.set(tc.toolName, existing);
  }

  const toolAnalysis: ToolAnalysis[] = [];
  const slowTools: string[] = [];
  const highErrorTools: string[] = [];

  for (const [name, stats] of toolGroups) {
    const errorRate = stats.calls > 0 ? stats.errors / stats.calls : 0;
    const avgMs = stats.calls > 0 ? Math.round(stats.totalMs / stats.calls) : 0;
    const isSlow = avgMs > SLOW_TOOL_THRESHOLD_MS;
    const isHighError = errorRate > HIGH_ERROR_RATE_THRESHOLD;

    if (isSlow) slowTools.push(name);
    if (isHighError) highErrorTools.push(name);

    toolAnalysis.push({
      toolName: name,
      totalCalls: stats.calls,
      totalErrors: stats.errors,
      errorRate: Math.round(errorRate * 100) / 100,
      avgDurationMs: avgMs,
      maxDurationMs: stats.maxMs,
      isSlow,
      isHighError,
    });
  }

  // Identify underused tools (expected but never called)
  const calledToolNames = new Set(toolGroups.keys());
  const underusedTools = (agentEntry?.expectedTools ?? []).filter(
    (t) => !calledToolNames.has(t)
  );

  // Calculate health score: start at 100, deduct for issues
  let healthScore = 100;
  const overallErrorRate =
    metrics.totalToolCalls > 0
      ? metrics.totalErrors / metrics.totalToolCalls
      : 0;

  healthScore -= Math.min(30, Math.round(overallErrorRate * 100)); // Up to -30 for errors
  healthScore -= slowTools.length * 10; // -10 per slow tool
  healthScore -= highErrorTools.length * 15; // -15 per high-error tool
  healthScore -= underusedTools.length * 5; // -5 per underused tool
  healthScore = Math.max(0, Math.min(100, healthScore));

  return {
    agentName,
    hasMetrics: true,
    totalToolCalls: metrics.totalToolCalls,
    totalErrors: metrics.totalErrors,
    overallErrorRate: Math.round(overallErrorRate * 100) / 100,
    totalDurationMs: metrics.totalDurationMs,
    toolAnalysis,
    slowTools,
    highErrorTools,
    underusedTools,
    healthScore,
  };
}

function checkStaleValues(): string[] {
  const findings: string[] = [];

  // Check BUREAUFLOW_CONTEXT for known values
  if (!BUREAUFLOW_CONTEXT.includes(DEMO_PHONE)) {
    findings.push(
      `BUREAUFLOW_CONTEXT does not contain current demo phone (${DEMO_PHONE})`
    );
  }

  if (!BUREAUFLOW_CONTEXT.includes("59 €/mo")) {
    findings.push(
      "BUREAUFLOW_CONTEXT pricing may be stale — Starter 59 not found"
    );
  }

  if (!BUREAUFLOW_CONTEXT.includes("bureauflow.de")) {
    findings.push("BUREAUFLOW_CONTEXT missing primary domain bureauflow.de");
  }

  // Check cron count matches automation map
  const automationMapCronCount = CRON_JOBS.length;
  if (automationMapCronCount < 20) {
    findings.push(
      `automation-map.ts only has ${automationMapCronCount} crons — expected 27+ per vercel.json`
    );
  }

  // Check webhook count
  if (WEBHOOKS.length < 3) {
    findings.push(
      `automation-map.ts only has ${WEBHOOKS.length} webhooks — expected at least 3 (Stripe, Resend, Vapi)`
    );
  }

  // Check agent source files exist
  for (const agent of KNOWN_AGENTS) {
    const agentPath = resolve(__dirname, agent.file);
    if (!existsSync(agentPath)) {
      findings.push(
        `Agent file missing: ${agent.file} — ${agent.name} cannot run`
      );
    }
  }

  // Check completed-tasks.json exists and is valid
  if (!existsSync(TASKS_PATH)) {
    findings.push("data/completed-tasks.json is missing — dedup-agent has no history");
  } else {
    try {
      const raw = readFileSync(TASKS_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.tasks)) {
        findings.push("data/completed-tasks.json has invalid structure — tasks is not an array");
      }
    } catch {
      findings.push("data/completed-tasks.json is not valid JSON");
    }
  }

  return findings;
}

function loadTaskStore(): { tasks: Array<{ id: string; description: string; completedAt: string; status: string; tags?: string[] }> } {
  if (!existsSync(TASKS_PATH)) {
    return { tasks: [] };
  }
  const raw = readFileSync(TASKS_PATH, "utf-8");
  return JSON.parse(raw);
}

function saveTaskStore(store: { tasks: Array<{ id: string; description: string; completedAt: string; status: string; tags?: string[] }> }): void {
  writeFileSync(TASKS_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// ─── Tools ─────────────────────────────────────────────────────────

const analyzeAgentPerformance = tool(
  "analyze_agent_performance",
  "Reads metrics tracked by hooks.ts for a specific agent (or all agents). Identifies slow tools (>5s avg), high-error tools (>10% failure rate), underused tools (never called), and calculates a health score 0-100.",
  {
    agentName: z
      .string()
      .optional()
      .describe("Specific agent name to analyze (e.g., 'support-agent'). Omit to analyze all agents."),
  },
  async ({ agentName }) => {
    const agentsToAnalyze = agentName
      ? KNOWN_AGENTS.filter((a) => a.name === agentName)
      : KNOWN_AGENTS;

    if (agentName && agentsToAnalyze.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Unknown agent: ${agentName}`,
              knownAgents: KNOWN_AGENTS.map((a) => a.name),
            }),
          },
        ],
      };
    }

    const performances = agentsToAnalyze.map((a) =>
      analyzeAgentMetrics(a.name)
    );

    const overallHealth =
      performances.length > 0
        ? Math.round(
            performances.reduce((sum, p) => sum + p.healthScore, 0) /
              performances.length
          )
        : 0;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            analyzedAt: new Date().toISOString(),
            agentCount: performances.length,
            overallHealthScore: overallHealth,
            performances,
            summary: {
              totalSlowTools: performances.flatMap((p) => p.slowTools).length,
              totalHighErrorTools: performances.flatMap((p) => p.highErrorTools).length,
              totalUnderusedTools: performances.flatMap((p) => p.underusedTools).length,
              agentsWithoutMetrics: performances.filter((p) => !p.hasMetrics).map((p) => p.agentName),
            },
          }),
        },
      ],
    };
  }
);

const suggestPromptImprovements = tool(
  "suggest_prompt_improvements",
  "Analyzes an agent's source file and system prompt for improvement opportunities: FAQ gaps, language consistency (German vs English), missing guardrails, edge case handling, and escalation patterns.",
  {
    agentName: z
      .string()
      .describe("Agent name to analyze (e.g., 'support-agent')"),
  },
  async ({ agentName }) => {
    const agent = KNOWN_AGENTS.find((a) => a.name === agentName);
    if (!agent) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Unknown agent: ${agentName}`,
              knownAgents: KNOWN_AGENTS.map((a) => a.name),
            }),
          },
        ],
      };
    }

    const agentPath = resolve(__dirname, agent.file);
    if (!existsSync(agentPath)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Agent file not found: ${agent.file}`,
              suggestion: "Ensure the agent file exists before analyzing its prompt.",
            }),
          },
        ],
      };
    }

    const source = readFileSync(agentPath, "utf-8");
    const suggestions: ImprovementSuggestion[] = [];

    // Check for BUREAUFLOW_CONTEXT usage
    if (!source.includes("BUREAUFLOW_CONTEXT")) {
      suggestions.push({
        priority: "P1",
        category: "prompt",
        agent: agentName,
        description: "Agent does not inject BUREAUFLOW_CONTEXT into system prompt",
        expectedImpact: "Agent may give incorrect product info (pricing, features, phone number)",
        suggestedAction: "Import BUREAUFLOW_CONTEXT from config.js and include in SYSTEM_PROMPT",
      });
    }

    // Check for German language handling
    const hasGermanKeywords = /[äöüß]|deutsch|german/i.test(source);
    if (agentName === "support-agent" && !hasGermanKeywords) {
      suggestions.push({
        priority: "P0",
        category: "prompt",
        agent: agentName,
        description: "Support agent lacks explicit German language handling",
        expectedImpact: "Revenue impact — German tradespeople expect German responses",
        suggestedAction: "Add German language rules to system prompt: respond in German when user writes in German",
      });
    }

    // Check for escalation path
    if (!source.includes(CEO_EMAIL) && !source.includes(OPS_EMAIL)) {
      suggestions.push({
        priority: "P1",
        category: "guardrails",
        agent: agentName,
        description: "Agent has no escalation email addresses configured",
        expectedImpact: "Critical issues may not reach the right person",
        suggestedAction: `Add escalation rules: P0 → ${CEO_EMAIL}, operational → ${OPS_EMAIL}`,
      });
    }

    // Check for error handling patterns
    if (!source.includes("try") && !source.includes("catch")) {
      suggestions.push({
        priority: "P1",
        category: "guardrails",
        agent: agentName,
        description: "No explicit try/catch error handling found in agent source",
        expectedImpact: "Unhandled errors may crash the agent silently",
        suggestedAction: "Add try/catch around main() and tool handlers with structured error logging",
      });
    }

    // Check for tool count
    const toolMatches = source.match(/\btool\(\s*"/g);
    const toolCount = toolMatches?.length ?? 0;
    if (toolCount === 0) {
      suggestions.push({
        priority: "P2",
        category: "tools",
        agent: agentName,
        description: "Agent has no custom tools defined — relies entirely on the LLM",
        expectedImpact: "Limited ability to perform structured operations",
        suggestedAction: "Consider adding at least one structured tool for the agent's primary function",
      });
    }

    // Check for system prompt structure (Anthropic 5-part: IDENTITY + STATIC_CONTEXT + EXAMPLES + GUARDRAILS + TOOLS)
    const has5Part =
      /IDENTITY|ROLE/i.test(source) &&
      /CONTEXT|KNOWLEDGE/i.test(source) &&
      /RULES|GUARDRAILS/i.test(source);
    if (!has5Part) {
      suggestions.push({
        priority: "P2",
        category: "prompt",
        agent: agentName,
        description: "System prompt may not follow Anthropic 5-part structure (IDENTITY + CONTEXT + EXAMPLES + GUARDRAILS + TOOLS)",
        expectedImpact: "Reduced prompt effectiveness and consistency across agents",
        suggestedAction: "Restructure system prompt with clear IDENTITY, STATIC_CONTEXT, EXAMPLES, GUARDRAILS, and TOOLS sections",
      });
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            agent: agentName,
            file: agent.file,
            toolCount,
            sourceLength: source.length,
            suggestions,
            analysisNote: suggestions.length === 0
              ? "No improvements identified — agent follows all best practices"
              : `Found ${suggestions.length} improvement(s) — ${suggestions.filter((s) => s.priority === "P0").length} critical`,
          }),
        },
      ],
    };
  }
);

const generateImprovementReport = tool(
  "generate_improvement_report",
  "Creates a structured improvement report covering all agents: per-agent health scores, ranked suggestions by impact, new tool proposals, system prompt patches, and stale data findings. Saves the report to data/evolution-report.json.",
  {
    includeStaleCheck: z
      .boolean()
      .optional()
      .describe("Whether to include stale data checks (default: true)"),
  },
  async ({ includeStaleCheck }) => {
    const performances = KNOWN_AGENTS.map((a) => analyzeAgentMetrics(a.name));
    const staleFindings =
      includeStaleCheck !== false ? checkStaleValues() : [];

    // Collect all suggestions
    const suggestions: ImprovementSuggestion[] = [];

    // Performance-based suggestions
    for (const perf of performances) {
      for (const slowTool of perf.slowTools) {
        suggestions.push({
          priority: "P1",
          category: "performance",
          agent: perf.agentName,
          description: `Tool "${slowTool}" is slow (avg >5s)`,
          expectedImpact: "Slower agent responses, higher API costs",
          suggestedAction: `Profile ${slowTool} execution, consider caching or reducing data fetched`,
        });
      }

      for (const errorTool of perf.highErrorTools) {
        suggestions.push({
          priority: "P0",
          category: "performance",
          agent: perf.agentName,
          description: `Tool "${errorTool}" has >10% error rate`,
          expectedImpact: "Revenue impact — unreliable tool causes failed customer interactions",
          suggestedAction: `Investigate ${errorTool} failures in logs, add retry logic or better error messages`,
        });
      }

      for (const unused of perf.underusedTools) {
        suggestions.push({
          priority: "P2",
          category: "tools",
          agent: perf.agentName,
          description: `Expected tool "${unused}" was never called`,
          expectedImpact: "Agent may not be using its full capability",
          suggestedAction: `Verify "${unused}" is correctly registered and the system prompt instructs the agent to use it`,
        });
      }
    }

    // Stale data suggestions
    for (const finding of staleFindings) {
      suggestions.push({
        priority: "P1",
        category: "data",
        agent: "all",
        description: finding,
        expectedImpact: "Agents may provide outdated information to users",
        suggestedAction: "Update the hardcoded value to match production",
      });
    }

    // Sort: P0 first, then P1, then P2
    const priorityOrder = { P0: 0, P1: 1, P2: 2 };
    suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    const overallHealth =
      performances.length > 0
        ? Math.round(
            performances.reduce((sum, p) => sum + p.healthScore, 0) /
              performances.length
          )
        : 0;

    const report: EvolutionReport = {
      generatedAt: new Date().toISOString(),
      agentPerformances: performances,
      suggestions,
      staleDataFindings: staleFindings,
      overallHealthScore: overallHealth,
    };

    // Persist the report
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf-8");

    // Build markdown summary
    const mdLines: string[] = [
      `# BureauFlow Evolution Report`,
      `Generated: ${report.generatedAt}`,
      `Overall Health: ${report.overallHealthScore}/100`,
      "",
      "## Agent Health Scores",
      ...performances.map(
        (p) =>
          `- **${p.agentName}**: ${p.healthScore}/100 (${p.totalToolCalls} tool calls, ${p.totalErrors} errors)`
      ),
      "",
      `## Suggestions (${suggestions.length} total)`,
      ...suggestions.map(
        (s, i) =>
          `${i + 1}. [${s.priority}] [${s.category}] **${s.agent}**: ${s.description}\n   Impact: ${s.expectedImpact}\n   Action: ${s.suggestedAction}`
      ),
      "",
      `## Stale Data (${staleFindings.length} findings)`,
      ...(staleFindings.length > 0
        ? staleFindings.map((f) => `- ${f}`)
        : ["- No stale data detected"]),
    ];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            reportSavedTo: REPORT_PATH,
            overallHealthScore: report.overallHealthScore,
            totalSuggestions: suggestions.length,
            byPriority: {
              P0: suggestions.filter((s) => s.priority === "P0").length,
              P1: suggestions.filter((s) => s.priority === "P1").length,
              P2: suggestions.filter((s) => s.priority === "P2").length,
            },
            markdownSummary: mdLines.join("\n"),
          }),
        },
      ],
    };
  }
);

const autoUpdateTaskHistory = tool(
  "auto_update_task_history",
  "Scans data/completed-tasks.json and adds any new tasks completed since the last check. Accepts a list of newly completed tasks to append, preventing the dedup-agent from having stale data.",
  {
    newTasks: z
      .array(
        z.object({
          id: z.string().describe("Unique kebab-case task identifier"),
          description: z.string().describe("What was done"),
          tags: z.array(z.string()).optional().describe("Keyword tags for matching"),
          status: z.enum(["done", "partial", "reverted"]).optional().describe("Task status (default: done)"),
        })
      )
      .describe("List of newly completed tasks to add to the history"),
  },
  async ({ newTasks }) => {
    const store = loadTaskStore();
    const existingIds = new Set(store.tasks.map((t) => t.id));
    const today = new Date().toISOString().split("T")[0];

    let added = 0;
    let skipped = 0;

    for (const task of newTasks) {
      if (existingIds.has(task.id)) {
        skipped++;
        continue;
      }

      store.tasks.push({
        id: task.id,
        description: task.description,
        completedAt: today,
        status: task.status ?? "done",
        tags: task.tags,
      });
      added++;
    }

    if (added > 0) {
      saveTaskStore(store);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            added,
            skipped,
            totalTasks: store.tasks.length,
            dataFile: TASKS_PATH,
          }),
        },
      ],
    };
  }
);

const checkForStaleData = tool(
  "check_for_stale_data",
  "Checks if any agent's hardcoded data is outdated: pricing in BUREAUFLOW_CONTEXT, demo phone number, campaign configs, cron schedule counts, and data file integrity.",
  {
    verbose: z
      .boolean()
      .optional()
      .describe("Include all checks even when passing (default: false — only report findings)"),
  },
  async ({ verbose }) => {
    const findings = checkStaleValues();

    // Additional checks with verbose output
    const allChecks: Array<{ check: string; status: "pass" | "fail"; detail: string }> = [];

    // Pricing check
    const pricingOk = BUREAUFLOW_CONTEXT.includes("59 €/mo");
    allChecks.push({
      check: "Starter pricing (59 EUR)",
      status: pricingOk ? "pass" : "fail",
      detail: pricingOk ? "Found in BUREAUFLOW_CONTEXT" : "Not found — may be stale",
    });

    // Demo phone check
    const phoneOk = BUREAUFLOW_CONTEXT.includes(DEMO_PHONE);
    allChecks.push({
      check: "Demo phone number",
      status: phoneOk ? "pass" : "fail",
      detail: phoneOk
        ? `${DEMO_PHONE} present in BUREAUFLOW_CONTEXT`
        : `${DEMO_PHONE} missing from BUREAUFLOW_CONTEXT`,
    });

    // Cron count check
    const cronCountOk = CRON_JOBS.length >= 20;
    allChecks.push({
      check: "Cron job count",
      status: cronCountOk ? "pass" : "fail",
      detail: `${CRON_JOBS.length} crons in automation-map (expected 27+)`,
    });

    // Webhook count check
    const webhookOk = WEBHOOKS.length >= 3;
    allChecks.push({
      check: "Webhook count",
      status: webhookOk ? "pass" : "fail",
      detail: `${WEBHOOKS.length} webhooks in automation-map (expected 3+)`,
    });

    // Task store health
    const taskStoreOk = existsSync(TASKS_PATH);
    let taskCount = 0;
    if (taskStoreOk) {
      try {
        const store = loadTaskStore();
        taskCount = store.tasks.length;
      } catch {
        // handled in findings
      }
    }
    allChecks.push({
      check: "Task store (completed-tasks.json)",
      status: taskStoreOk ? "pass" : "fail",
      detail: taskStoreOk ? `${taskCount} tasks stored` : "File missing",
    });

    // Agent file existence
    for (const agent of KNOWN_AGENTS) {
      const exists = existsSync(resolve(__dirname, agent.file));
      allChecks.push({
        check: `Agent file: ${agent.file}`,
        status: exists ? "pass" : "fail",
        detail: exists ? "File exists" : "FILE MISSING",
      });
    }

    const passed = allChecks.filter((c) => c.status === "pass").length;
    const failed = allChecks.filter((c) => c.status === "fail").length;

    const output = verbose
      ? allChecks
      : allChecks.filter((c) => c.status === "fail");

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            checkedAt: new Date().toISOString(),
            passed,
            failed,
            findings,
            checks: output,
          }),
        },
      ],
    };
  }
);

// ─── MCP Server ────────────────────────────────────────────────────

export const evolveMcp = createSdkMcpServer({
  name: "bureauflow-evolve-tools",
  version: "1.0.0",
  tools: [
    analyzeAgentPerformance,
    suggestPromptImprovements,
    generateImprovementReport,
    autoUpdateTaskHistory,
    checkForStaleData,
  ],
});

// ─── Memory File Path ──────────────────────────────────────────────

const MEMORY_DIR = resolve(
  process.env.HOME ?? "~",
  ".claude",
  "projects",
  "-Users-tomasmarty",
  "memory"
);

function loadMemorySummary(): string {
  const memoryPath = resolve(MEMORY_DIR, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    return "(MEMORY.md not found — operating without project memory)";
  }
  const raw = readFileSync(memoryPath, "utf-8");
  return raw.slice(0, 3000);
}

// ─── System Prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are the BureauFlow Evolution Agent — a continuous improvement engineer for the agent suite.

IDENTITY:
- Purpose: Analyze, measure, and improve all BureauFlow agents
- Role: Data-driven improvement engine — only suggest changes with measurable expected impact
- Language: English for internal ops
- Style: Precise, quantitative, reference specific metrics and thresholds
- Principle: NEVER suggest changes for the sake of change

STATIC CONTEXT:
${BUREAUFLOW_CONTEXT}

CURRENT PROJECT MEMORY:
${loadMemorySummary()}

KNOWN AGENTS:
${KNOWN_AGENTS.map((a) => `- ${a.name} (${a.file}): ${a.description}`).join("\n")}

YOUR TOOLS:
1. analyze_agent_performance — Read hook metrics, identify slow/error-prone/underused tools, calculate health scores
2. suggest_prompt_improvements — Inspect agent source code for prompt quality, language consistency, missing guardrails
3. generate_improvement_report — Full structured report: health scores, ranked suggestions, stale data findings
4. auto_update_task_history — Append new completed tasks to keep dedup-agent current
5. check_for_stale_data — Verify hardcoded values (pricing, phone, crons) match production

WORKFLOW:
1. Start with analyze_agent_performance for ALL agents to get the current state
2. For any agent scoring below 80, run suggest_prompt_improvements
3. Always finish with generate_improvement_report to create the actionable output
4. If asked to update task history, use auto_update_task_history
5. Periodically run check_for_stale_data to catch drift

PRIORITY FRAMEWORK:
- P0 (Revenue Impact): Broken tools, wrong pricing, failed customer interactions
- P1 (Efficiency): Slow tools, missing escalation paths, stale data
- P2 (Nice-to-Have): Prompt structure improvements, unused tools, cosmetic issues

RULES:
- Be data-driven — every suggestion must reference a specific metric or finding
- Quantify expected impact (e.g., "reduce avg response time from 8s to 3s")
- Never suggest removing a working tool — only improving or supplementing
- Report to ${OPS_EMAIL} for operational improvements
- Alert ${CEO_EMAIL} only for P0 revenue-impacting findings
- Keep reports concise — Tomas has ADHD, walls of text get skipped

REPORT PATH: ${REPORT_PATH}
TASK HISTORY: ${TASKS_PATH}
`.trim();

// ─── Exported Agent Definition ─────────────────────────────────────

export const evolveAgentDefinition = {
  description:
    "Continuous improvement agent that analyzes all other agents' performance, identifies issues, and generates data-driven improvement reports. Run daily to maintain agent health.",
  prompt: SYSTEM_PROMPT,
  model: "sonnet" as const,
  maxTurns: 12,
  tools: [],
};

// ─── Run Agent (standalone) ────────────────────────────────────────

async function main() {
  const userPrompt =
    process.argv.slice(2).join(" ") ||
    "Analyze all agents, check for stale data, and generate a full improvement report.";

  console.log(`\n🧬 BureauFlow Evolution Agent — Continuous Improvement`);
  console.log(`📋 Query: ${userPrompt}\n`);

  const conversation = query({
    prompt: userPrompt,
    options: {
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "bureauflow-evolve-tools": evolveMcp },
      maxTurns: DEFAULT_MAX_TURNS,
      effort: "medium",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: [],
      persistSession: false,
    },
  });

  for await (const message of conversation) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if ("text" in block && block.text) {
          console.log(block.text);
        }
      }
    } else if (message.type === "result") {
      console.log(
        `\n✅ Evolution analysis complete (${message.duration_ms}ms, $${message.total_cost_usd.toFixed(4)})`
      );
    }
  }
}

main().catch(console.error);
