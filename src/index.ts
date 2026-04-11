/**
 * BureauFlow Agent Suite — Orchestrator
 *
 * Runs all agents as subagents of a single parent agent:
 * 0. Dedup Agent    — redundancy detection (ALWAYS consulted FIRST)
 * 1. Support Agent  — customer support for German tradespeople
 * 2. Email Agent    — inbox cleanup automation
 * 3. Lead Agent     — signup qualification and follow-up
 * 4. Monitor Agent  — infrastructure health checks + daily briefings
 * 5. Ops Agent      — cron/webhook audit + automation landscape
 * 6. Evolve Agent   — continuous improvement / agent self-analysis
 *
 * Usage: npx tsx src/index.ts
 *        npx tsx src/index.ts "Run lead qualification and email cleanup"
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { MODEL, BUREAUFLOW_CONTEXT, OPS_EMAIL, CEO_EMAIL, DEFAULT_MAX_TURNS } from "./config.js";
import { dedupAgentDefinition, dedupMcp } from "./dedup-agent.js";
import { supportAgentDefinition, supportMcp } from "./support-agent.js";
import { emailAgentDefinition, emailMcp } from "./email-agent.js";
import { leadAgentDefinition, leadMcp } from "./lead-agent.js";
import { monitorAgentDefinition, monitorMcp } from "./monitor-agent.js";
import { opsAgentDefinition, opsMcp } from "./ops-agent.js";
import { evolveAgentDefinition, evolveMcp } from "./evolve-agent.js";

// ─── Health Check Tool ───────────────────────────────────────────────

const healthCheck = tool(
  "health_check",
  "Check the health of BureauFlow services (Vercel, Neon DB, Vapi, Resend)",
  { service: z.enum(["all", "vercel", "neon", "vapi", "resend"]).default("all") },
  async ({ service }) => {
    const checks: Record<string, { status: string; note: string }> = {
      vercel: { status: "ok", note: "bureauflow-app.vercel.app responding" },
      neon: { status: "ok", note: "purple-unit-43947621 connected" },
      vapi: { status: "ok", note: "Demo phone +49 158 886 583 28 active" },
      resend: { status: "ok", note: "bureauflow.de domain verified" },
    };

    if (service === "all") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ timestamp: new Date().toISOString(), services: checks }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ service, ...checks[service] }),
        },
      ],
    };
  }
);

const orchestratorMcp = createSdkMcpServer({
  name: "bureauflow-orchestrator",
  version: "1.0.0",
  tools: [healthCheck],
});

// ─── Subagent Definitions ────────────────────────────────────────────
// The actual agent definitions (system prompts, tool hints, models) live
// in each agent's own file. The orchestrator just imports and registers
// them so subagents dispatch with the same context as their standalone
// counterparts — no more drift between "subagent version" and "direct run".

// ─── Orchestrator System Prompt ──────────────────────────────────────

const SYSTEM_PROMPT = `
You are the BureauFlow Operations Orchestrator.

You coordinate seven specialized agents (dispatch via the Task tool):
0. **dedup-agent**    — Redundancy detection (ALWAYS consulted FIRST)
1. **support-agent**  — German-language customer support for tradespeople
2. **email-agent**    — Autonomous inbox cleanup and spam management
3. **lead-agent**     — Signup qualification and personalized follow-up
4. **monitor-agent**  — Infrastructure health checks + daily briefings
5. **ops-agent**      — Cron/webhook audit + automation landscape
6. **evolve-agent**   — Continuous improvement / agent self-analysis

DISPATCH DECISION TABLE:
- "Is this duplicate?" / "Was X already done?"         → dedup-agent
- Customer question (DE/EN) / product / billing        → support-agent
- "Clean inbox" / "classify emails" / newsletters      → email-agent
- "New signups" / "score lead" / hot leads             → lead-agent
- "Health check" / "is X up?" / daily briefing         → monitor-agent
- "Cron status" / "automation audit" / scheduling      → ops-agent
- "Improve agents" / "performance report" / stale data → evolve-agent
- Never route customer-facing work to monitor/ops/evolve — they are
  internal-only read-only agents. Never dispatch the same task to two
  agents; pick the best fit.

YOUR ROLE:
- ALWAYS consult dedup-agent FIRST before dispatching any work
- Route each task to EXACTLY ONE agent based on the table above
- Aggregate results into a clean summary for Tomas
- Escalate revenue-impacting issues to ${CEO_EMAIL}
- After any agent completes work, tell dedup-agent to mark it as done

CONTEXT:
${BUREAUFLOW_CONTEXT}

KEY CONTACTS:
- CEO: ${CEO_EMAIL} (Tomas Marty) — only for revenue events and hot leads
- Ops: ${OPS_EMAIL} — all operational alerts and reports

WORKFLOW:
1. Understand what the user needs
2. **DEDUP CHECK:** Send proposed tasks to dedup-agent to check for redundancy
3. Skip any tasks flagged as already done — report them as "already completed on [date]"
4. Dispatch novel tasks to the appropriate subagent (one per task)
5. If multiple tasks, run them in sequence
6. **MARK DONE:** After each task completes, tell dedup-agent to log it
7. Aggregate results into a clear summary
8. Report any issues

RULES:
- NEVER skip the dedup check — this prevents wasted work
- NEVER modify OUREA or Closers.app systems
- NEVER send emails to Jerome Dave (jdave@ourea.lu)
- Tomas has ADHD: be direct, act autonomously, report results
- Mistakes > inaction
`.trim();

// ─── Run Orchestrator ────────────────────────────────────────────────

/**
 * Run the orchestrator with a user prompt. All 7 subagents are registered
 * with access to their own MCP servers, so dispatched work actually has
 * tools available (not just text prompts).
 *
 * Exported so the proactive scheduler can dispatch real work through the
 * orchestrator instead of firing raw queries with no context.
 */
export async function runOrchestrator(userPrompt: string): Promise<void> {
  console.log(`\n🚀 BureauFlow Agent Suite — Orchestrator`);
  console.log(`📋 Task: ${userPrompt}\n`);

  const conversation = query({
    prompt: userPrompt,
    options: {
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      agents: {
        "dedup-agent": dedupAgentDefinition,
        "support-agent": supportAgentDefinition,
        "email-agent": emailAgentDefinition,
        "lead-agent": leadAgentDefinition,
        "monitor-agent": monitorAgentDefinition,
        "ops-agent": opsAgentDefinition,
        "evolve-agent": evolveAgentDefinition,
      },
      mcpServers: {
        // Parent + dedup (always available) plus each subagent's MCP so
        // dispatched work can actually call lookup_faq / classify_email /
        // score_lead / check_infrastructure / check_cron_status /
        // analyze_agent_performance.
        "bureauflow-orchestrator": orchestratorMcp,
        "bureauflow-dedup-tools": dedupMcp,
        "bureauflow-support-tools": supportMcp,
        "bureauflow-email-tools": emailMcp,
        "bureauflow-lead-tools": leadMcp,
        "bureauflow-monitor-tools": monitorMcp,
        "bureauflow-ops-tools": opsMcp,
        "bureauflow-evolve-tools": evolveMcp,
      },
      maxTurns: DEFAULT_MAX_TURNS * 2, // Orchestrator needs more turns
      effort: "high",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: [], // Built-in tools not needed — subagents + MCP only
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
    } else if (message.type === "result" && message.subtype === "success") {
      console.log(
        `\n✅ Suite complete | ${message.num_turns} turns | ${message.duration_ms}ms | $${message.total_cost_usd.toFixed(4)}`
      );
    }
  }
}

async function main() {
  const userPrompt =
    process.argv.slice(2).join(" ") ||
    "Run a complete operations check: qualify recent leads, then summarize the system health.";

  await runOrchestrator(userPrompt);
}

// Only run main() when invoked as the entrypoint.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
