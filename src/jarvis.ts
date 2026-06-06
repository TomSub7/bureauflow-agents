/**
 * BureauFlow Jarvis — Unified Autonomous Orchestrator
 *
 * The single entry point that ties the whole suite together. Takes a
 * natural-language request and routes it to the right specialist subagent,
 * with all of their tools wired in:
 *
 *   - dedup-agent    → redundancy check (consulted FIRST)
 *   - support-agent  → German customer support
 *   - email-agent    → inbox triage/cleanup
 *   - lead-agent     → signup scoring + follow-up
 *   - ops-agent      → cron/automation health
 *   - monitor-agent  → infrastructure health + CEO briefing
 *
 * Jarvis itself can also reach external research/creation tools when their
 * API keys are configured: Perplexity (web search), Firecrawl (crawl/scrape),
 * and glif (image/video generation). Browser servers (Playwright, Chrome
 * DevTools) are configured for the Claude Code CLI in .mcp.json but need a
 * local desktop session, so they are not wired into this headless runner.
 *
 * Unlike the old scheduler/orchestrator, this actually attaches every
 * subagent's MCP tools (previously index.ts left subagents tool-less — see
 * REMEDIATION.md M5).
 *
 * Usage: npx tsx src/jarvis.ts "Qualify today's leads, then brief me on system health"
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentDefinition,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import {
  BUREAUFLOW_CONTEXT,
  OPS_EMAIL,
  CEO_EMAIL,
  DEFAULT_MAX_TURNS,
  AGENT_RULES,
  createAgentOptions,
} from "./config.js";
import { supportMcp } from "./support-agent.js";
import { emailMcp } from "./email-agent.js";
import { leadMcp } from "./lead-agent.js";
import { opsMcp } from "./ops-agent.js";
import { monitorMcp } from "./monitor-agent.js";
import { dedupMcp } from "./dedup-agent.js";
import { getAvailableMcpServers } from "./mcp-connectors.js";

// ─── In-process MCP servers (one per specialist agent) ──────────────

const IN_PROCESS_MCP: Record<string, McpServerConfig> = {
  "bureauflow-support-tools": supportMcp,
  "bureauflow-email-tools": emailMcp,
  "bureauflow-lead-tools": leadMcp,
  "bureauflow-ops-tools": opsMcp,
  "bureauflow-monitor-tools": monitorMcp,
  "bureauflow-dedup-tools": dedupMcp,
};

// Fully-qualified tool names as exposed by the SDK: mcp__<server>__<tool>.
const t = (server: string, name: string) => `mcp__${server}__${name}`;

// ─── External research/creation MCP servers (env-gated, headless-safe) ──
// Mirrors .mcp.json so Jarvis can use these tools programmatically too.

function buildExternalMcpServers(): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  if (process.env.PERPLEXITY_API_KEY) {
    servers["perplexity"] = {
      type: "stdio",
      command: "npx",
      args: ["-y", "@perplexity-ai/mcp-server"],
      env: { PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY },
    };
  }
  if (process.env.FIRECRAWL_API_KEY) {
    servers["firecrawl"] = {
      type: "stdio",
      command: "npx",
      args: ["-y", "firecrawl-mcp"],
      env: { FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY },
    };
  }
  if (process.env.GLIF_API_TOKEN) {
    servers["glif"] = {
      type: "stdio",
      command: "npx",
      args: ["-y", "@glifxyz/glif-mcp-server@latest"],
      env: { GLIF_API_TOKEN: process.env.GLIF_API_TOKEN },
    };
  }

  return servers;
}

// ─── Subagent definitions (with their tools actually wired in) ──────

const dedupAgent: AgentDefinition = {
  description:
    "Redundancy detector and project historian. ALWAYS consult FIRST to check whether a task was already completed in a prior session.",
  prompt: `You are the BureauFlow Dedup Agent — the project historian.
${AGENT_RULES}
Check proposed work against the completed-tasks log before anything runs.
Report "REDUNDANT — [id] on [date]" or "NOVEL". State which sources you checked.`,
  model: "sonnet",
  tools: [
    t("bureauflow-dedup-tools", "check_if_done"),
    t("bureauflow-dedup-tools", "mark_as_done"),
    t("bureauflow-dedup-tools", "list_completed"),
    t("bureauflow-dedup-tools", "find_redundancies"),
  ],
};

const supportAgent: AgentDefinition = {
  description:
    "German-language customer support for tradespeople. Answers product questions, checks subscriptions, escalates when needed.",
  prompt: `Du bist der BureauFlow Kundensupport-Agent. Antworte auf Deutsch.
${BUREAUFLOW_CONTEXT}
Immer zuerst lookup_faq nutzen; check_subscription bei Kontofragen; bei
Abrechnungs-/Eskalationsfällen escalate_to_human (kritisch → ${CEO_EMAIL}, sonst ${OPS_EMAIL}).`,
  model: "sonnet",
  tools: [
    t("bureauflow-support-tools", "lookup_faq"),
    t("bureauflow-support-tools", "check_subscription"),
    t("bureauflow-support-tools", "escalate_to_human"),
  ],
};

const emailAgent: AgentDefinition = {
  description:
    "Inbox triage. Classifies emails keep/archive/delete and reports. Never deletes protected senders; keeps anything business/lead-like.",
  prompt: `You are the BureauFlow Email Cleanup Agent.
Classify each email with classify_email. When confidence < 0.7, KEEP it.
German emails from unknown senders are likely leads — KEEP. Summarize with report_cleanup.`,
  model: "sonnet",
  tools: [
    t("bureauflow-email-tools", "classify_email"),
    t("bureauflow-email-tools", "report_cleanup"),
  ],
};

const leadAgent: AgentDefinition = {
  description:
    "Signup qualification. Scores leads, drafts tier-appropriate follow-ups, flags HOT leads for the CEO.",
  prompt: `You are the BureauFlow Lead Qualification Agent.
${BUREAUFLOW_CONTEXT}
check_recent_signups → score_lead → draft_follow_up. HOT (60+) → alert ${CEO_EMAIL}.
Alejandro Cruz Libreros is a BUSINESS PARTNER, not a lead.`,
  model: "sonnet",
  tools: [
    t("bureauflow-lead-tools", "check_recent_signups"),
    t("bureauflow-lead-tools", "score_lead"),
    t("bureauflow-lead-tools", "draft_follow_up"),
  ],
};

const opsAgent: AgentDefinition = {
  description:
    "Read-only automation/cron health. Audits cron config, flags scheduling conflicts, produces ops reports.",
  prompt: `You are the BureauFlow Operations Agent (read-only/advisory).
Use check_cron_status, get_system_health, generate_ops_report.
Flag crons sharing a schedule (Vercel concurrency risk). Escalate ${OPS_EMAIL} → ${CEO_EMAIL}.`,
  model: "sonnet",
  tools: [
    t("bureauflow-ops-tools", "check_cron_status"),
    t("bureauflow-ops-tools", "get_system_health"),
    t("bureauflow-ops-tools", "generate_ops_report"),
  ],
};

const monitorAgent: AgentDefinition = {
  description:
    "SRE-grade infrastructure supervisor. Pings live services, audits crons, produces the daily CEO briefing, alerts only on red.",
  prompt: `You are the BureauFlow Meta-Monitor Agent (read-only).
Run check_agent_health, check_infrastructure, check_cron_health, then generate_daily_briefing.
Only alert_ceo for RED, revenue-impacting events. Exclude your own prior outputs (no self-reference).`,
  model: "sonnet",
  tools: [
    t("bureauflow-monitor-tools", "check_agent_health"),
    t("bureauflow-monitor-tools", "check_infrastructure"),
    t("bureauflow-monitor-tools", "check_cron_health"),
    t("bureauflow-monitor-tools", "generate_daily_briefing"),
    t("bureauflow-monitor-tools", "alert_ceo"),
  ],
};

// ─── Jarvis system prompt (routing brain) ───────────────────────────

const SYSTEM_PROMPT = `
You are Jarvis — the BureauFlow autonomous operations assistant for Tomas Marty (CEO).

You coordinate six specialists and can do your own research/creation:
0. dedup-agent    — ALWAYS consult FIRST to avoid redoing finished work
1. support-agent  — German customer support
2. email-agent    — inbox triage
3. lead-agent     — signup scoring + follow-up
4. ops-agent      — cron/automation health
5. monitor-agent  — infrastructure health + CEO briefing

Your own tools (when configured):
- Perplexity (perplexity_search / perplexity_ask) for live web research
- Firecrawl (firecrawl_scrape / firecrawl_search) to pull web content
- glif (run_glif) for image/video generation

${BUREAUFLOW_CONTEXT}

${AGENT_RULES}

ROUTING:
1. Restate the goal in one line.
2. DEDUP CHECK: ask dedup-agent whether the work was already done; skip what's redundant.
3. Dispatch novel work to the right specialist(s); run independent steps together.
4. Use your own research/creation tools when a step needs live web data or media.
5. After each completed task, tell dedup-agent to mark it done.
6. Aggregate into one crisp summary. Escalate only revenue/outage items to ${CEO_EMAIL}; routine to ${OPS_EMAIL}.

RULES:
- Act autonomously; Tomas has ADHD — be direct, finish the chain, don't ask "what's next".
- NEVER modify OUREA/Closers systems or email Jerome Dave (jdave@ourea.lu).
- Mistakes > inaction, but verify the product works before blaming sales/marketing (LESSON ZERO).
`.trim();

// ─── Run Jarvis ─────────────────────────────────────────────────────

async function main() {
  const userPrompt =
    process.argv.slice(2).join(" ") ||
    "Run a full operations pass: dedup-check first, qualify recent leads, audit cron health, then give me a one-screen status briefing.";

  const externalMcp = buildExternalMcpServers();
  const externalNames = Object.keys(externalMcp);

  console.log(`\n🤖 BureauFlow Jarvis — Unified Orchestrator`);
  console.log(`📋 Goal: ${userPrompt}`);
  console.log(
    `🔌 External tools: ${externalNames.length ? externalNames.join(", ") : "none configured"}\n`
  );

  const conversation = query({
    prompt: userPrompt,
    options: {
      ...createAgentOptions({
        agentName: "jarvis",
        maxTurns: DEFAULT_MAX_TURNS * 2, // orchestration needs headroom
        effort: "high",
      }),
      systemPrompt: SYSTEM_PROMPT,
      agents: {
        "dedup-agent": dedupAgent,
        "support-agent": supportAgent,
        "email-agent": emailAgent,
        "lead-agent": leadAgent,
        "ops-agent": opsAgent,
        "monitor-agent": monitorAgent,
      },
      mcpServers: {
        ...IN_PROCESS_MCP,
        ...getAvailableMcpServers(), // gmail/stripe/calendar/composio if env present
        ...externalMcp, // perplexity/firecrawl/glif if keys present
      },
      // No `tools` restriction at the top level: Jarvis may call any registered
      // MCP tool directly; subagents are limited to their own allowlists above.
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
        `\n✅ Jarvis complete | ${message.num_turns} turns | ${message.duration_ms}ms | $${message.total_cost_usd.toFixed(4)}`
      );
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
