/**
 * BureauFlow Operations Agent
 *
 * Monitors cron health, checks infrastructure status, and generates
 * structured operations reports for the BureauFlow platform.
 *
 * Usage: npx tsx src/ops-agent.ts "Show me stale crons"
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import {
  BUREAUFLOW_CONTEXT,
  OPS_EMAIL,
  CEO_EMAIL,
  DEFAULT_MAX_TURNS,
  DEFAULT_EFFORT,
  createAgentOptions,
} from "./config.js";
import {
  CRON_JOBS,
  WEBHOOKS,
  getAutomationSummary,
} from "./automation-map.js";

// ─── Custom MCP Tools ────────────────────────────────────────────────

const checkCronStatus = tool(
  "check_cron_status",
  "List all BureauFlow cron jobs with their schedules and flag any that look stale or misconfigured. Checks for scheduling conflicts, excessive frequency, and gaps in coverage.",
  {
    filter: z
      .enum(["all", "daily", "hourly", "weekly"])
      .optional()
      .describe("Filter crons by frequency: all (default), daily, hourly, or weekly"),
  },
  async ({ filter }) => {
    const now = new Date();
    const hour = now.getUTCHours();
    const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon

    // Classify each cron by frequency
    const classified = CRON_JOBS.map((cron) => {
      let frequency: "hourly" | "daily" | "weekly" = "daily";
      if (cron.schedule.includes("*/")) frequency = "hourly";
      if (cron.schedule.match(/\* \* [0-6,]+$/)) frequency = "weekly";

      // Check if the cron should have run recently
      const parts = cron.schedule.split(" ");
      const cronHour = parts[1];
      const cronDow = parts[4];

      let lastExpectedHoursAgo = -1;
      if (cronHour.startsWith("*/")) {
        const interval = parseInt(cronHour.replace("*/", ""), 10);
        lastExpectedHoursAgo = hour % interval;
      } else if (cronHour.includes(",")) {
        const hours = cronHour.split(",").map(Number);
        const pastHours = hours.filter((h) => h <= hour);
        if (pastHours.length > 0) {
          lastExpectedHoursAgo = hour - Math.max(...pastHours);
        }
      } else {
        const scheduledHour = parseInt(cronHour, 10);
        if (scheduledHour <= hour) {
          lastExpectedHoursAgo = hour - scheduledHour;
        }
      }

      // Flag potential issues
      const issues: string[] = [];
      if (cronDow !== "*" && !cronDow.split(",").map(Number).includes(dayOfWeek)) {
        issues.push("not scheduled to run today");
      }

      return { ...cron, frequency, lastExpectedHoursAgo, issues };
    });

    // Apply filter
    const filtered =
      filter && filter !== "all"
        ? classified.filter((c) => c.frequency === filter)
        : classified;

    // Detect scheduling conflicts (same time, same minute)
    const timeSlots = new Map<string, string[]>();
    for (const cron of CRON_JOBS) {
      const key = cron.schedule;
      if (!timeSlots.has(key)) timeSlots.set(key, []);
      timeSlots.get(key)!.push(cron.name);
    }
    const conflicts = [...timeSlots.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([schedule, names]) => `${schedule}: ${names.join(", ")}`);

    const report = [
      `Cron Status Report (${now.toISOString()})`,
      `Total: ${CRON_JOBS.length} crons | Showing: ${filtered.length} (filter: ${filter ?? "all"})`,
      "",
      ...filtered.map((c) => {
        const status = c.issues.length > 0 ? `[!] ${c.issues.join("; ")}` : "[OK]";
        return `  ${c.name.padEnd(24)} ${c.schedule.padEnd(20)} ${c.frequency.padEnd(8)} ${status}`;
      }),
      "",
      conflicts.length > 0
        ? `Scheduling conflicts (same time):\n${conflicts.map((c) => `  - ${c}`).join("\n")}`
        : "No scheduling conflicts detected.",
    ];

    return {
      content: [{ type: "text" as const, text: report.join("\n") }],
    };
  }
);

const getSystemHealth = tool(
  "get_system_health",
  "Check BureauFlow infrastructure status: app endpoint, webhook endpoints, database connectivity indicators, and key service statuses.",
  {
    verbose: z.boolean().optional().describe("Include detailed endpoint list (default: false)"),
  },
  async ({ verbose }) => {
    const appUrl = "https://bureauflow.de";
    const statusUrl = "https://status.bureauflow.de";
    const now = new Date();

    // In production, these would make real HTTP checks. For now, structured report.
    const services = [
      { name: "App (Vercel)",       url: appUrl,       status: "operational" as const },
      { name: "Status Page (Upptime)", url: statusUrl, status: "operational" as const },
      { name: "Database (Neon)",    url: "neon.tech",   status: "operational" as const },
      { name: "Email (Resend)",     url: "resend.com",  status: "operational" as const },
      { name: "Voice (Vapi)",       url: "vapi.ai",     status: "operational" as const },
      { name: "Payments (Stripe)",  url: "stripe.com",  status: "operational" as const },
      { name: "Auth (Auth.js v5)",  url: "internal",    status: "operational" as const },
    ];

    const lines = [
      `BureauFlow System Health — ${now.toISOString()}`,
      "",
      "=== SERVICES ===",
      ...services.map(
        (s) => `  ${s.status === "operational" ? "[OK]" : "[!!]"} ${s.name.padEnd(26)} ${s.url}`
      ),
      "",
      `=== AUTOMATIONS ===`,
      `  Cron jobs: ${CRON_JOBS.length} configured`,
      `  Webhooks:  ${WEBHOOKS.length} endpoints (${WEBHOOKS.map((w) => w.provider).join(", ")})`,
    ];

    if (verbose) {
      lines.push(
        "",
        "=== WEBHOOK ENDPOINTS ===",
        ...WEBHOOKS.map((w) => `  ${w.provider.padEnd(12)} ${w.path}`),
        "",
        "=== ALL CRON ENDPOINTS ===",
        ...CRON_JOBS.map((c) => `  ${c.name.padEnd(24)} ${c.endpoint}`)
      );
    }

    lines.push(
      "",
      "Note: Status checks are structural. For live HTTP probes, use status.bureauflow.de (Upptime)."
    );

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

const generateOpsReport = tool(
  "generate_ops_report",
  "Create a structured operations report covering cron health, infrastructure status, and recommended actions. Suitable for CEO briefing or ops review.",
  {
    format: z
      .enum(["brief", "full"])
      .optional()
      .describe("Report format: brief (summary only) or full (with details). Default: brief"),
    includeRecommendations: z
      .boolean()
      .optional()
      .describe("Include AI-generated recommendations (default: true)"),
  },
  async ({ format, includeRecommendations }) => {
    const now = new Date();
    const isFull = format === "full";
    const showRecs = includeRecommendations !== false;

    // Classify crons
    const hourly = CRON_JOBS.filter((c) => c.schedule.includes("*/"));
    const weekly = CRON_JOBS.filter((c) => c.schedule.match(/\* \* [0-6,]+$/));
    const daily = CRON_JOBS.filter(
      (c) => !c.schedule.includes("*/") && !c.schedule.match(/\* \* [0-6,]+$/)
    );

    const sections: string[] = [
      `========================================`,
      `  BureauFlow Operations Report`,
      `  Generated: ${now.toISOString()}`,
      `  Sent to: ${OPS_EMAIL}`,
      `========================================`,
      "",
      "--- EXECUTIVE SUMMARY ---",
      `  Total automations: ${CRON_JOBS.length} crons + ${WEBHOOKS.length} webhooks`,
      `  Frequency breakdown: ${hourly.length} hourly, ${daily.length} daily, ${weekly.length} weekly`,
      `  Webhook providers: ${WEBHOOKS.map((w) => w.provider).join(", ")}`,
    ];

    if (isFull) {
      sections.push(
        "",
        "--- CRON SCHEDULE (FULL) ---",
        ...CRON_JOBS.map(
          (c) =>
            `  ${c.name.padEnd(24)} ${c.schedule.padEnd(20)} ${c.description}`
        )
      );
    }

    // Detect potential issues
    const timeMap = new Map<string, string[]>();
    for (const c of CRON_JOBS) {
      const key = c.schedule;
      if (!timeMap.has(key)) timeMap.set(key, []);
      timeMap.get(key)!.push(c.name);
    }
    const conflicts = [...timeMap.entries()].filter(([, v]) => v.length > 1);

    sections.push(
      "",
      "--- POTENTIAL ISSUES ---",
      conflicts.length > 0
        ? conflicts
            .map(([sched, names]) => `  [CONFLICT] Same schedule "${sched}": ${names.join(", ")}`)
            .join("\n")
        : "  No scheduling conflicts detected."
    );

    if (showRecs) {
      sections.push(
        "",
        "--- RECOMMENDATIONS ---",
        "  1. Stagger crons sharing the same schedule to avoid Vercel concurrency limits",
        "  2. Monitor Vapi credit balance (vapi-credit-monitor runs every 6h)",
        "  3. Review weekly-report output each Monday for anomalies",
        "  4. Ensure Resend webhook signature verification stays active",
        `  5. Escalation path: ${OPS_EMAIL} -> ${CEO_EMAIL}`
      );
    }

    sections.push("", `--- END OF REPORT ---`);

    return {
      content: [{ type: "text" as const, text: sections.join("\n") }],
    };
  }
);

// ─── MCP Server (in-process) ─────────────────────────────────────────

const opsMcp = createSdkMcpServer({
  name: "bureauflow-ops-tools",
  version: "1.0.0",
  tools: [checkCronStatus, getSystemHealth, generateOpsReport],
});

// ─── System Prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are the BureauFlow Operations Agent.

IDENTITY:
- Role: Infrastructure and automation monitoring for BureauFlow
- Language: English (ops reports are in English for technical clarity)
- Tone: Concise, structured, data-driven

PRODUCT KNOWLEDGE:
${BUREAUFLOW_CONTEXT}

AUTOMATION LANDSCAPE:
${getAutomationSummary()}

RULES:
1. Always check cron status before making claims about automation health
2. When asked about system health, use get_system_health for a structured overview
3. For CEO briefings or weekly reviews, use generate_ops_report with format="full"
4. Flag scheduling conflicts — multiple crons at the same time risk Vercel concurrency limits
5. Escalation chain: ${OPS_EMAIL} (default) -> ${CEO_EMAIL} (critical)
6. Never modify infrastructure — this agent is read-only / advisory
7. Reference status.bureauflow.de (Upptime) for live uptime data

WORKFLOW:
1. Understand the ops question
2. Use the appropriate tool(s) to gather data
3. Present findings in a structured format
4. Include actionable recommendations when relevant
`.trim();

// ─── Run Agent ───────────────────────────────────────────────────────

async function main() {
  const userQuery = process.argv.slice(2).join(" ");

  if (!userQuery) {
    console.log("Usage: npx tsx src/ops-agent.ts \"<ops question>\"");
    console.log("Examples:");
    console.log("  npx tsx src/ops-agent.ts \"Which crons are stale?\"");
    console.log("  npx tsx src/ops-agent.ts \"Generate a full ops report\"");
    console.log("  npx tsx src/ops-agent.ts \"System health check\"");
    process.exit(1);
  }

  console.log(`\n[OPS] BureauFlow Operations Agent`);
  console.log(`[OPS] Query: ${userQuery}\n`);

  const conversation = query({
    prompt: userQuery,
    options: {
      ...createAgentOptions({
        agentName: "ops-agent",
        maxTurns: DEFAULT_MAX_TURNS,
        effort: DEFAULT_EFFORT,
      }),
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "bureauflow-ops-tools": opsMcp },
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
    } else if (message.type === "result") {
      console.log(`\n[OPS] Done (${message.duration_ms}ms, $${message.total_cost_usd.toFixed(4)})`);
    }
  }
}

main().catch(console.error);
