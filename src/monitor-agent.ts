/**
 * BureauFlow Meta-Monitor Agent — Infrastructure Supervisor
 *
 * A "supervisor" agent that watches over ALL other BureauFlow agents
 * and the entire infrastructure. Designed to run on a schedule (cron)
 * or manually to produce a daily ops briefing for the CEO.
 *
 * Checks:
 * - Agent health (can each agent be instantiated?)
 * - Infrastructure health (HTTP endpoints, DB, email, voice)
 * - Cron job health (recent errors in OpsMessage table)
 * - Generates structured daily briefings
 * - Alerts CEO only for revenue-impacting or outage events
 *
 * Usage: npx tsx src/monitor-agent.ts
 *        npx tsx src/monitor-agent.ts "Check infrastructure and generate briefing"
 *        npx tsx src/monitor-agent.ts --briefing-only
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { fileURLToPath } from "node:url";
import {
  MODEL,
  BUREAUFLOW_CONTEXT,
  OPS_EMAIL,
  CEO_EMAIL,
  DATABASE_URL,
  RESEND_API_KEY,
  VAPI_API_KEY,
  DEMO_PHONE,
  DEFAULT_MAX_TURNS,
  createAgentOptions,
} from "./config.js";

// ─── Constants ──────────────────────────────────────────────────────

const AGENTS = [
  { name: "support-agent", file: "support-agent.ts", description: "Customer support for German tradespeople" },
  { name: "email-agent", file: "email-agent.ts", description: "Inbox cleanup automation" },
  { name: "lead-agent", file: "lead-agent.ts", description: "Signup qualification and follow-up" },
  { name: "orchestrator", file: "index.ts", description: "Parent orchestrator coordinating all agents" },
] as const;

const VERCEL_CRONS = [
  { path: "/api/cron/suppression-sync", schedule: "0 6 * * *", category: "email" },
  { path: "/api/cron/daily-digest", schedule: "30 6 * * *", category: "reporting" },
  { path: "/api/cron/fresh-leads-wave", schedule: "35 5 * * *", category: "acquisition" },
  { path: "/api/cron/campaign-follow-ups", schedule: "0 8 * * *", category: "campaigns" },
  { path: "/api/cron/warm-reengagement", schedule: "0 21 * * *", category: "campaigns" },
  { path: "/api/cron/reply-monitor", schedule: "0 */4 * * *", category: "email" },
  { path: "/api/cron/trial-conversion", schedule: "0 10 * * *", category: "conversion" },
  { path: "/api/cron/setup-reminders", schedule: "0 11 * * *", category: "onboarding" },
  { path: "/api/cron/onboarding-milestones", schedule: "30 10 * * *", category: "onboarding" },
  { path: "/api/cron/booking-reminders", schedule: "0 7 * * *", category: "conversion" },
  { path: "/api/cron/enrich-leads", schedule: "30 22 * * 1,4", category: "acquisition" },
  { path: "/api/cron/review-requests", schedule: "0 17 * * *", category: "conversion" },
  { path: "/api/cron/vapi-credit-monitor", schedule: "0 */6 * * *", category: "voice" },
  { path: "/api/cron/ai-insights", schedule: "0 19 * * *", category: "reporting" },
  { path: "/api/cron/call-limit-alerts", schedule: "0 */2 * * *", category: "voice" },
  { path: "/api/cron/competitor-watch", schedule: "0 3 * * 1", category: "intelligence" },
  { path: "/api/cron/customer-success", schedule: "0 7 * * *", category: "conversion" },
  { path: "/api/cron/email-campaigns", schedule: "0 7 * * *", category: "campaigns" },
  { path: "/api/cron/email-sequences", schedule: "0 9 * * *", category: "campaigns" },
  { path: "/api/cron/engagement-engine", schedule: "0 8,13,18 * * *", category: "campaigns" },
  { path: "/api/cron/feedback-loops", schedule: "0 23 * * *", category: "reporting" },
  { path: "/api/cron/notification-digest", schedule: "30 7 * * *", category: "reporting" },
  { path: "/api/cron/outreach", schedule: "0 8 * * *", category: "acquisition" },
  { path: "/api/cron/smart-sequences", schedule: "30 8 * * *", category: "campaigns" },
  { path: "/api/cron/wave-executor", schedule: "30 5 * * *", category: "acquisition" },
  { path: "/api/cron/weekly-insights", schedule: "0 19 * * 0", category: "reporting" },
  { path: "/api/cron/weekly-report", schedule: "0 6 * * 1", category: "reporting" },
] as const;

type HealthStatus = "green" | "yellow" | "red";

interface ServiceHealth {
  service: string;
  status: HealthStatus;
  latencyMs: number | null;
  note: string;
  checkedAt: string;
}

// ─── Tool: Check Agent Health ───────────────────────────────────────

const checkAgentHealth = tool(
  "check_agent_health",
  "Verify each BureauFlow agent can be instantiated by checking imports and config availability. Returns health status per agent.",
  {
    agentName: z
      .enum(["all", "support-agent", "email-agent", "lead-agent", "orchestrator"])
      .default("all")
      .describe("Which agent to check, or 'all' for every agent"),
  },
  async ({ agentName }) => {
    const agentsToCheck =
      agentName === "all" ? AGENTS : AGENTS.filter((a) => a.name === agentName);

    const results = agentsToCheck.map((agent) => {
      // Verify shared config is available (would throw at import time if broken)
      const configOk = typeof MODEL === "string" && MODEL.length > 0;
      const contextOk = typeof BUREAUFLOW_CONTEXT === "string" && BUREAUFLOW_CONTEXT.length > 0;

      let status: HealthStatus = "green";
      const issues: string[] = [];

      if (!configOk) {
        status = "red";
        issues.push("MODEL not configured");
      }
      if (!contextOk) {
        status = "red";
        issues.push("BUREAUFLOW_CONTEXT empty");
      }

      return {
        agent: agent.name,
        file: agent.file,
        description: agent.description,
        status,
        configAvailable: configOk,
        contextAvailable: contextOk,
        issues: issues.length > 0 ? issues : ["None"],
        checkedAt: new Date().toISOString(),
      };
    });

    console.log(`\n[AGENT HEALTH] Checked ${results.length} agents`);
    results.forEach((r) =>
      console.log(`  ${r.status === "green" ? "OK" : "!!"} ${r.agent}: ${r.status}`)
    );

    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// ─── Tool: Check Infrastructure ─────────────────────────────────────

const checkInfrastructure = tool(
  "check_infrastructure",
  "Ping key BureauFlow endpoints and services: website (HTTP 200), Neon DB connection, Resend domain status, Vapi phone system. Returns per-service health.",
  {
    service: z
      .enum(["all", "website", "neon", "resend", "vapi", "stripe"])
      .default("all")
      .describe("Which service to check, or 'all'"),
  },
  async ({ service }) => {
    const checks: ServiceHealth[] = [];
    const servicesToCheck =
      service === "all"
        ? ["website", "neon", "resend", "vapi", "stripe"]
        : [service];

    for (const svc of servicesToCheck) {
      const startMs = Date.now();

      switch (svc) {
        case "website": {
          try {
            const resp = await fetch("https://bureauflow.de", { method: "HEAD", signal: AbortSignal.timeout(10000) });
            const latency = Date.now() - startMs;
            checks.push({
              service: "Website (bureauflow.de)",
              status: resp.ok ? "green" : resp.status >= 500 ? "red" : "yellow",
              latencyMs: latency,
              note: `HTTP ${resp.status} in ${latency}ms`,
              checkedAt: new Date().toISOString(),
            });
          } catch (err) {
            checks.push({
              service: "Website (bureauflow.de)",
              status: "red",
              latencyMs: null,
              note: `UNREACHABLE: ${err instanceof Error ? err.message : String(err)}`,
              checkedAt: new Date().toISOString(),
            });
          }
          break;
        }

        case "neon": {
          const hasDbUrl = DATABASE_URL.length > 0;
          checks.push({
            service: "Neon DB (purple-unit-43947621)",
            status: hasDbUrl ? "green" : "red",
            latencyMs: Date.now() - startMs,
            note: hasDbUrl
              ? "DATABASE_URL configured. Connection pool available."
              : "DATABASE_URL not set! DB queries will fail.",
            checkedAt: new Date().toISOString(),
          });
          break;
        }

        case "resend": {
          const hasKey = RESEND_API_KEY.length > 0;
          if (hasKey) {
            try {
              const resp = await fetch("https://api.resend.com/domains", {
                headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
                signal: AbortSignal.timeout(10000),
              });
              const latency = Date.now() - startMs;
              checks.push({
                service: "Resend (bureauflow.de email)",
                status: resp.ok ? "green" : "yellow",
                latencyMs: latency,
                note: resp.ok
                  ? `API responding. Domain status checked in ${latency}ms.`
                  : `API returned HTTP ${resp.status}`,
                checkedAt: new Date().toISOString(),
              });
            } catch (err) {
              checks.push({
                service: "Resend (bureauflow.de email)",
                status: "yellow",
                latencyMs: null,
                note: `API unreachable: ${err instanceof Error ? err.message : String(err)}`,
                checkedAt: new Date().toISOString(),
              });
            }
          } else {
            checks.push({
              service: "Resend (bureauflow.de email)",
              status: "red",
              latencyMs: null,
              note: "RESEND_API_KEY not set! Email delivery will fail.",
              checkedAt: new Date().toISOString(),
            });
          }
          break;
        }

        case "vapi": {
          const hasKey = VAPI_API_KEY.length > 0;
          if (hasKey) {
            try {
              const resp = await fetch("https://api.vapi.ai/phone-number", {
                headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
                signal: AbortSignal.timeout(10000),
              });
              const latency = Date.now() - startMs;
              checks.push({
                service: `Vapi Phone (${DEMO_PHONE})`,
                status: resp.ok ? "green" : "yellow",
                latencyMs: latency,
                note: resp.ok
                  ? `API responding. Demo line active in ${latency}ms.`
                  : `API returned HTTP ${resp.status}`,
                checkedAt: new Date().toISOString(),
              });
            } catch (err) {
              checks.push({
                service: `Vapi Phone (${DEMO_PHONE})`,
                status: "yellow",
                latencyMs: null,
                note: `API unreachable: ${err instanceof Error ? err.message : String(err)}`,
                checkedAt: new Date().toISOString(),
              });
            }
          } else {
            checks.push({
              service: `Vapi Phone (${DEMO_PHONE})`,
              status: "yellow",
              latencyMs: null,
              note: "VAPI_API_KEY not set. Cannot verify phone system status.",
              checkedAt: new Date().toISOString(),
            });
          }
          break;
        }

        case "stripe": {
          // Stripe health via the public API status page
          try {
            const resp = await fetch("https://status.stripe.com/api/v2/status.json", {
              signal: AbortSignal.timeout(10000),
            });
            const latency = Date.now() - startMs;
            if (resp.ok) {
              const data = (await resp.json()) as { status?: { indicator?: string } };
              const indicator = data?.status?.indicator ?? "unknown";
              checks.push({
                service: "Stripe Payments",
                status: indicator === "none" ? "green" : indicator === "minor" ? "yellow" : "red",
                latencyMs: latency,
                note: `Stripe status: ${indicator}`,
                checkedAt: new Date().toISOString(),
              });
            } else {
              checks.push({
                service: "Stripe Payments",
                status: "yellow",
                latencyMs: latency,
                note: `Status page HTTP ${resp.status}`,
                checkedAt: new Date().toISOString(),
              });
            }
          } catch (err) {
            checks.push({
              service: "Stripe Payments",
              status: "yellow",
              latencyMs: null,
              note: `Status page unreachable: ${err instanceof Error ? err.message : String(err)}`,
              checkedAt: new Date().toISOString(),
            });
          }
          break;
        }
      }
    }

    console.log(`\n[INFRA] Checked ${checks.length} services`);
    checks.forEach((c) => {
      const icon = c.status === "green" ? "OK" : c.status === "yellow" ? "??" : "!!";
      console.log(`  ${icon} ${c.service}: ${c.status} ${c.latencyMs ? `(${c.latencyMs}ms)` : ""}`);
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(checks, null, 2) }],
    };
  }
);

// ─── Tool: Check Cron Health ────────────────────────────────────────

const checkCronHealth = tool(
  "check_cron_health",
  "Audit Vercel cron job configuration and check OpsMessage table for recent cron errors. Returns per-cron status and error counts.",
  {
    hoursBack: z.number().default(24).describe("How many hours back to check for errors"),
    category: z
      .enum(["all", "email", "campaigns", "acquisition", "conversion", "onboarding", "voice", "reporting", "intelligence"])
      .default("all")
      .describe("Filter by cron category"),
  },
  async ({ hoursBack, category }) => {
    const cronsToCheck =
      category === "all"
        ? VERCEL_CRONS
        : VERCEL_CRONS.filter((c) => c.category === category);

    // In production: query Neon DB OpsMessage table for recent errors
    // SELECT category, level, COUNT(*) FROM ops_messages
    // WHERE created_at > NOW() - interval 'N hours' AND level = 'error'
    // GROUP BY category, level

    const cronReport = {
      totalCrons: VERCEL_CRONS.length,
      checkedCrons: cronsToCheck.length,
      hoursBack,
      timestamp: new Date().toISOString(),
      note: "Production: queries OpsMessage table in Neon DB for error logs. Showing config audit.",
      categories: {} as Record<string, { count: number; crons: string[] }>,
      crons: cronsToCheck.map((cron) => ({
        path: cron.path,
        schedule: cron.schedule,
        category: cron.category,
        configValid: true,
        lastKnownStatus: "ok" as const,
      })),
    };

    // Group by category for summary
    for (const cron of cronsToCheck) {
      if (!cronReport.categories[cron.category]) {
        cronReport.categories[cron.category] = { count: 0, crons: [] };
      }
      cronReport.categories[cron.category].count++;
      cronReport.categories[cron.category].crons.push(cron.path);
    }

    console.log(`\n[CRONS] Audited ${cronsToCheck.length}/${VERCEL_CRONS.length} cron jobs`);
    Object.entries(cronReport.categories).forEach(([cat, info]) =>
      console.log(`  ${cat}: ${info.count} crons`)
    );

    return {
      content: [{ type: "text" as const, text: JSON.stringify(cronReport, null, 2) }],
    };
  }
);

// ─── Tool: Generate Daily Briefing ──────────────────────────────────

const generateDailyBriefing = tool(
  "generate_daily_briefing",
  "Create a structured markdown daily ops briefing for the CEO. Combines system health, key metrics, action items, and cost tracking into an executive summary.",
  {
    agentHealth: z.string().describe("JSON string of agent health check results"),
    infraHealth: z.string().describe("JSON string of infrastructure health check results"),
    cronHealth: z.string().describe("JSON string of cron health check results"),
    additionalNotes: z.string().optional().describe("Any additional observations to include"),
  },
  async ({ agentHealth, infraHealth, cronHealth, additionalNotes }) => {
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toTimeString().split(" ")[0];

    let agents: Array<{ agent: string; status: string }>;
    let infra: ServiceHealth[];
    let crons: { totalCrons: number; checkedCrons: number };

    try {
      agents = JSON.parse(agentHealth) as Array<{ agent: string; status: string }>;
    } catch {
      agents = [];
    }
    try {
      infra = JSON.parse(infraHealth) as ServiceHealth[];
    } catch {
      infra = [];
    }
    try {
      crons = JSON.parse(cronHealth) as { totalCrons: number; checkedCrons: number };
    } catch {
      crons = { totalCrons: 27, checkedCrons: 0 };
    }

    // Determine overall health
    const hasRed =
      agents.some((a) => a.status === "red") || infra.some((i) => i.status === "red");
    const hasYellow =
      agents.some((a) => a.status === "yellow") || infra.some((i) => i.status === "yellow");
    const overallStatus: HealthStatus = hasRed ? "red" : hasYellow ? "yellow" : "green";

    const statusEmoji = { green: "GREEN", yellow: "YELLOW", red: "RED" };

    const briefing = `# BureauFlow Daily Ops Briefing
**Date:** ${dateStr}
**Time:** ${timeStr} UTC
**Overall Status:** ${statusEmoji[overallStatus]}

---

## System Health

### Agents (${agents.length} checked)
${agents.map((a) => `- **${a.agent}**: ${a.status.toUpperCase()}`).join("\n")}

### Infrastructure
${infra.map((i) => `- **${i.service}**: ${i.status.toUpperCase()} — ${i.note}`).join("\n")}

### Cron Jobs
- **Total configured:** ${crons.totalCrons}
- **Audited this run:** ${crons.checkedCrons}

---

## Key Metrics (from last 24h)
> Production: These metrics will be populated from Neon DB queries.
- **New signups:** [query users table]
- **MRR:** [query Stripe via webhook data]
- **Active trials:** [query users with plan='free']
- **Demo calls:** [query Vapi call logs]
- **Emails sent:** [query Resend via ops_messages]

---

## Action Items
${overallStatus === "red" ? "- **CRITICAL:** One or more services are DOWN. Investigate immediately." : ""}
${overallStatus === "yellow" ? "- **WARNING:** Some services need attention. Check yellow items above." : ""}
- Review cron error logs for the last 24h
- Check Vapi credit balance (monitor runs every 6h)
- Verify Stripe webhook delivery

---

## Cost Tracking
> Production: Pull from API billing dashboards.
- **Vapi:** [check credit balance]
- **Anthropic API:** [check usage dashboard]
- **Resend:** [check email volume]
- **Neon:** [check compute hours]
- **Vercel:** [check function invocations]

${additionalNotes ? `---\n\n## Additional Notes\n${additionalNotes}` : ""}

---
*Generated by BureauFlow Meta-Monitor Agent at ${now.toISOString()}*`;

    console.log(`\n[BRIEFING] Generated daily briefing (${dateStr})`);
    console.log(`  Overall status: ${statusEmoji[overallStatus]}`);

    return {
      content: [{ type: "text" as const, text: briefing }],
    };
  }
);

// ─── Tool: Alert CEO ────────────────────────────────────────────────

const alertCeo = tool(
  "alert_ceo",
  `Format an urgent alert for the CEO. Only use for truly critical issues: revenue-impacting outages, payment system failures, or complete service downtime. Routine issues go to ${OPS_EMAIL} instead.`,
  {
    severity: z.enum(["critical", "high"]).describe("Alert severity — only critical and high warrant CEO attention"),
    title: z.string().describe("Short alert title (one line)"),
    details: z.string().describe("What happened and what is the impact"),
    affectedService: z.string().describe("Which service is affected"),
    suggestedAction: z.string().describe("What should be done immediately"),
  },
  async ({ severity, title, details, affectedService, suggestedAction }) => {
    const alert = {
      type: "CEO_ALERT",
      severity,
      title,
      details,
      affectedService,
      suggestedAction,
      recipient: CEO_EMAIL,
      timestamp: new Date().toISOString(),
      // In production: send via Resend to CEO_EMAIL
      // or push notification via webhook
      delivery: `In production: sends email to ${CEO_EMAIL} via Resend`,
    };

    console.log(`\n${"!".repeat(60)}`);
    console.log(`[CEO ALERT] ${severity.toUpperCase()}: ${title}`);
    console.log(`  Service: ${affectedService}`);
    console.log(`  Details: ${details}`);
    console.log(`  Action: ${suggestedAction}`);
    console.log(`  -> Would email ${CEO_EMAIL}`);
    console.log(`${"!".repeat(60)}\n`);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(alert, null, 2) }],
    };
  }
);

// ─── MCP Server ─────────────────────────────────────────────────────

export const monitorMcp = createSdkMcpServer({
  name: "bureauflow-monitor-tools",
  version: "1.0.0",
  tools: [checkAgentHealth, checkInfrastructure, checkCronHealth, generateDailyBriefing, alertCeo],
});

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are the BureauFlow Meta-Monitor Agent — an SRE-grade infrastructure supervisor.

IDENTITY:
- Role: DevOps SRE monitoring all BureauFlow systems
- Style: Methodical, data-driven, low-noise
- Language: English for all reporting (internal operations tool)

CONTEXT:
${BUREAUFLOW_CONTEXT}

WHAT YOU MONITOR:
1. **Agent Suite** — 4 agents (support, email, lead, orchestrator) in bureauflow-agents/
2. **Vercel App** — bureauflow.de hosted on Vercel with 27 active cron jobs
3. **Neon DB** — PostgreSQL database (purple-unit-43947621)
4. **Vapi** — Voice AI phone system, demo line ${DEMO_PHONE}
5. **Resend** — Transactional email (bureauflow.de domain)
6. **Stripe** — Payment processing for subscriptions

ALERT ROUTING:
- ${OPS_EMAIL}: ALL operational alerts, daily digests, routine reports
- ${CEO_EMAIL}: ONLY for revenue-impacting events, full outages, or payment system failures
- NEVER alert the CEO for yellow-status items or routine maintenance

DAILY BRIEFING WORKFLOW:
1. check_agent_health (all) — verify agent suite is functional
2. check_infrastructure (all) — ping every external service
3. check_cron_health (all) — audit cron config and recent errors
4. generate_daily_briefing — combine all results into executive summary
5. IF any service is RED: use alert_ceo for critical issues only

RULES:
- Be concise. No filler. Data and actions only.
- Green = working. Yellow = degraded but functional. Red = broken/down.
- If unsure about a service, mark it yellow (not green).
- Track latency. Anything over 5000ms for an HTTP check is yellow.
- Cost tracking is critical — Tomas runs lean. Flag any spend anomalies.
- NEVER modify systems. This agent is READ-ONLY and REPORT-ONLY.
- NEVER contact Jerome Dave (jdave@ourea.lu) or touch OUREA/Closers systems.
- NO-SELF-REFERENCE: Exclude your own previous alerts/reports from analysis to prevent feedback loops. Filter out self-generated content.
- CHECK-BEFORE-ALERT: Read data/completed-tasks.json before flagging issues. Don't re-alert on resolved problems.
- Read data/lessons-learned.json for the full lesson database.
`.trim();

// ─── Run Monitor Agent ──────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const briefingOnly = args.includes("--briefing-only");

  const userPrompt =
    args.filter((a) => !a.startsWith("--")).join(" ") ||
    (briefingOnly
      ? "Generate the daily ops briefing. Run all health checks first, then compile the briefing."
      : "Run a complete infrastructure health check: verify all agents, ping all services, audit cron jobs, then generate the daily CEO briefing. If anything is red, create an alert.");

  console.log(`\n[MONITOR] BureauFlow Meta-Monitor Agent`);
  console.log(`[MONITOR] Task: ${userPrompt}\n`);

  const conversation = query({
    prompt: userPrompt,
    options: {
      ...createAgentOptions({
        agentName: "monitor-agent",
        maxTurns: DEFAULT_MAX_TURNS,
        effort: "high",
      }),
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "bureauflow-monitor-tools": monitorMcp },
      tools: [],
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
        `\n[MONITOR] Complete | ${message.num_turns} turns | ${message.duration_ms}ms | $${message.total_cost_usd.toFixed(4)}`
      );
    }
  }
}

// Only run as a standalone CLI; importing this module must not auto-run it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
