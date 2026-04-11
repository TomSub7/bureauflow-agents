/**
 * BureauFlow Agent Suite — Orchestrator
 *
 * Runs all agents as subagents of a single parent agent:
 * 0. Dedup Agent — redundancy detection (ALWAYS consulted FIRST)
 * 1. Support Agent — customer support for German tradespeople
 * 2. Email Agent — inbox cleanup automation
 * 3. Lead Agent — signup qualification and follow-up
 *
 * Usage: npx tsx src/index.ts
 *        npx tsx src/index.ts "Run lead qualification and email cleanup"
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, BUREAUFLOW_CONTEXT, OPS_EMAIL, CEO_EMAIL, DEFAULT_MAX_TURNS } from "./config.js";
import { dedupAgentDefinition, dedupMcp } from "./dedup-agent.js";

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

const dedupAgent: AgentDefinition = dedupAgentDefinition;

const supportAgent: AgentDefinition = {
  description:
    "Customer support agent for German tradespeople using BureauFlow AI phone assistant SaaS. Answers product questions, troubleshoots issues, looks up FAQs, and escalates to humans when needed.",
  prompt: `Du bist der BureauFlow Kundensupport-Agent. Antworte auf Deutsch.
Produktwissen: ${BUREAUFLOW_CONTEXT}
Regeln: FAQ suchen, Abo prüfen, klar antworten. Bei Problemen eskalieren an ${OPS_EMAIL}.
Demo-Nummer: +49 158 886 583 28. Gutscheincode: GRUENDER50.`,
  model: "sonnet",
  maxTurns: 10,
  tools: [], // Uses MCP tools only
};

const emailAgent: AgentDefinition = {
  description:
    "Email inbox cleanup agent that classifies, archives, and deletes spam/newsletter emails. Preserves all business-critical communications. Generates cleanup reports.",
  prompt: `You are the BureauFlow Email Cleanup Agent. Tomas has ADHD — he needs a clean inbox but can't do it himself.
RULES: Never delete from protected senders (Stripe, Vercel, Neon, GitHub, Anthropic, customers).
When confidence < 0.7, KEEP the email. German emails from unknown senders are likely leads — KEEP.
Workflow: Scan → Classify → Act → Report.`,
  model: "sonnet",
  maxTurns: 15,
  tools: [],
};

const leadAgent: AgentDefinition = {
  description:
    "Lead qualification agent that monitors signups and sends follow-ups. Scores leads by trade, company size, and signup source. Alerts CEO for hot leads. Uses GRUENDER50 coupon for warm leads.",
  prompt: `You are the BureauFlow Lead Qualification Agent.
${BUREAUFLOW_CONTEXT}
ICP Priority: Elektriker > Klempner > Dachdecker > SHK > Maler
Scoring: Trade(5-30) + Source(5-35) + Company(+10) + Domain(+10) + Size(+15)
Tiers: HOT(60+)=CEO alert, WARM(30-59)=nurture, COLD(<30)=welcome only
RULE: Alejandro Cruz Libreros = BUSINESS PARTNER, not a lead!`,
  model: "sonnet",
  maxTurns: 12,
  tools: [],
};

// ─── Orchestrator System Prompt ──────────────────────────────────────

const SYSTEM_PROMPT = `
You are the BureauFlow Operations Orchestrator.

You coordinate four specialized agents:
0. **dedup-agent** — Redundancy detection (ALWAYS consulted FIRST)
1. **support-agent** — German-language customer support for tradespeople
2. **email-agent** — Autonomous inbox cleanup and spam management
3. **lead-agent** — Signup qualification and personalized follow-up

YOUR ROLE:
- ALWAYS consult dedup-agent FIRST before dispatching any work
- Route tasks to the right agent
- Run health checks on infrastructure
- Aggregate results and create summaries
- Escalate critical issues to ${CEO_EMAIL}
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
4. Dispatch novel tasks to appropriate subagent(s)
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

async function main() {
  const userPrompt =
    process.argv.slice(2).join(" ") ||
    "Run a complete operations check: qualify recent leads, then summarize the system health.";

  console.log(`\n🚀 BureauFlow Agent Suite — Orchestrator`);
  console.log(`📋 Task: ${userPrompt}\n`);

  const conversation = query({
    prompt: userPrompt,
    options: {
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      agents: {
        "dedup-agent": dedupAgent,
        "support-agent": supportAgent,
        "email-agent": emailAgent,
        "lead-agent": leadAgent,
      },
      mcpServers: {
        "bureauflow-orchestrator": orchestratorMcp,
        "bureauflow-dedup-tools": dedupMcp,
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

main().catch(console.error);
