/**
 * BureauFlow Email Cleanup Agent
 *
 * Autonomous inbox cleanup agent that:
 * 1. Identifies spam, newsletters, and marketing emails
 * 2. Unsubscribes from unwanted lists
 * 3. Archives/deletes low-value emails
 * 4. Preserves all business-critical communications
 *
 * Usage: npx tsx src/email-agent.ts
 *        npx tsx src/email-agent.ts --dry-run
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { MODEL, CEO_EMAIL, OPS_EMAIL, DEFAULT_MAX_TURNS } from "./config.js";

// ─── Safety Lists ────────────────────────────────────────────────────
// NEVER auto-delete emails from these domains/senders
const PROTECTED_SENDERS = [
  "bureauflow.de",
  "bureauflow.io",
  "stripe.com",
  "vercel.com",
  "neon.tech",
  "resend.com",
  "github.com",
  "vapi.ai",
  "anthropic.com",
  "google.com",       // GCP, OAuth, etc.
  "apple.com",
  "ourea.lu",
  "closers.app",
  "porkbun.com",
  "cloudflare.com",
  "lexware.de",
  // Known business contacts
  "millo.gmbh",
  "bubic.de",
  "sentinelegal.ch",
];

// Auto-delete senders (known spam/marketing already confirmed by Tomas)
const AUTO_DELETE_SENDERS = [
  "noreply@medium.com",
  "newsletter@",
  "marketing@",
  "promo@",
  "no-reply@producthunt.com",
  "digest@quora.com",
];

// ─── Custom Tools ────────────────────────────────────────────────────

const classifyEmail = tool(
  "classify_email",
  "Classify an email as keep/archive/delete based on sender, subject, and content analysis",
  {
    sender: z.string().describe("Email sender address"),
    subject: z.string().describe("Email subject line"),
    snippet: z.string().optional().describe("First 200 chars of email body"),
  },
  async ({ sender, subject, snippet }) => {
    const senderLower = sender.toLowerCase();

    // Check protected list
    if (PROTECTED_SENDERS.some((p) => senderLower.includes(p))) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              action: "keep",
              reason: "Protected sender — business-critical",
              sender,
              confidence: 1.0,
            }),
          },
        ],
      };
    }

    // Check auto-delete list
    if (AUTO_DELETE_SENDERS.some((p) => senderLower.includes(p))) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              action: "delete",
              reason: "Known unwanted sender (auto-delete list)",
              sender,
              confidence: 0.95,
            }),
          },
        ],
      };
    }

    // Heuristic classification
    const subjectLower = (subject ?? "").toLowerCase();
    const snippetLower = (snippet ?? "").toLowerCase();

    const spamSignals = [
      subjectLower.includes("unsubscribe"),
      subjectLower.includes("newsletter"),
      subjectLower.includes("sale") || subjectLower.includes("offer"),
      subjectLower.includes("limited time"),
      snippetLower.includes("click here to unsubscribe"),
      snippetLower.includes("you are receiving this because"),
      senderLower.includes("noreply"),
      senderLower.includes("no-reply"),
    ].filter(Boolean).length;

    const businessSignals = [
      subjectLower.includes("invoice") || subjectLower.includes("rechnung"),
      subjectLower.includes("payment") || subjectLower.includes("zahlung"),
      subjectLower.includes("contract") || subjectLower.includes("vertrag"),
      subjectLower.includes("meeting") || subjectLower.includes("termin"),
      snippetLower.includes("handwerk") || snippetLower.includes("elektro"),
    ].filter(Boolean).length;

    let action: "keep" | "archive" | "delete";
    let confidence: number;

    if (businessSignals > 0) {
      action = "keep";
      confidence = 0.8 + businessSignals * 0.05;
    } else if (spamSignals >= 3) {
      action = "delete";
      confidence = 0.7 + spamSignals * 0.05;
    } else if (spamSignals >= 1) {
      action = "archive";
      confidence = 0.6;
    } else {
      action = "keep";
      confidence = 0.5; // Low confidence = let agent decide
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            action,
            reason: `Spam signals: ${spamSignals}, Business signals: ${businessSignals}`,
            sender,
            confidence: Math.min(confidence, 1.0),
          }),
        },
      ],
    };
  }
);

const reportCleanupResults = tool(
  "report_cleanup",
  "Generate a summary report of the email cleanup actions taken",
  {
    kept: z.number().describe("Number of emails kept"),
    archived: z.number().describe("Number of emails archived"),
    deleted: z.number().describe("Number of emails deleted"),
    unsubscribed: z.number().describe("Number of lists unsubscribed from"),
    errors: z.array(z.string()).optional().describe("Any errors encountered"),
  },
  async ({ kept, archived, deleted, unsubscribed, errors }) => {
    const report = [
      `=== Email Cleanup Report ===`,
      `Kept:         ${kept}`,
      `Archived:     ${archived}`,
      `Deleted:      ${deleted}`,
      `Unsubscribed: ${unsubscribed}`,
      `Errors:       ${errors?.length ?? 0}`,
      errors?.length ? `\nErrors:\n${errors.map((e) => `  - ${e}`).join("\n")}` : "",
      `\nReport sent to ${OPS_EMAIL}`,
    ]
      .filter(Boolean)
      .join("\n");

    console.log(`\n${report}`);

    return {
      content: [{ type: "text" as const, text: report }],
    };
  }
);

// ─── MCP Server ──────────────────────────────────────────────────────

const emailMcp = createSdkMcpServer({
  name: "bureauflow-email-tools",
  version: "1.0.0",
  tools: [classifyEmail, reportCleanupResults],
});

// ─── System Prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are the BureauFlow Email Cleanup Agent.

IDENTITY:
- Purpose: Autonomously clean up Tomas Marty's inbox (CEO of BureauFlow)
- Language: English for internal ops
- Style: Efficient, no-nonsense, report results clearly

CONTEXT:
Tomas has ADHD. He needs his inbox clean but cannot do it himself.
The inbox receives:
1. Business emails (customers, partners, leads) — ALWAYS KEEP
2. Infrastructure alerts (Vercel, Stripe, Neon, Resend) — KEEP
3. Newsletters and marketing — CLASSIFY then DELETE or ARCHIVE
4. Spam — DELETE immediately
5. Social media notifications — ARCHIVE unless from business contacts

PROTECTED SENDERS (NEVER delete):
${PROTECTED_SENDERS.map((s) => `- ${s}`).join("\n")}

RULES:
1. When confidence < 0.7, KEEP the email (false positives are worse than clutter)
2. Always classify before deleting — use the classify_email tool
3. Generate a cleanup report at the end using report_cleanup
4. If an email looks like a customer inquiry, KEEP it regardless of sender
5. German-language emails from unknown senders are likely leads — KEEP them
6. Any email mentioning "Handwerker", "Elektriker", "Klempner", etc. is business — KEEP

WORKFLOW:
1. Scan inbox for unread/recent emails
2. Classify each email
3. Execute actions (keep/archive/delete)
4. Attempt unsubscribe for deleted marketing emails
5. Generate report
`.trim();

// ─── Run Agent ───────────────────────────────────────────────────────

async function main() {
  const isDryRun = process.argv.includes("--dry-run");

  console.log(`\n📧 BureauFlow Email Cleanup Agent`);
  console.log(`Mode: ${isDryRun ? "DRY RUN (no deletions)" : "LIVE"}\n`);

  const prompt = isDryRun
    ? "Scan my inbox and classify emails. DO NOT delete anything — just report what you would do. This is a dry run."
    : "Clean up my inbox. Classify all recent emails, delete spam and unwanted newsletters, archive low-priority items. Generate a cleanup report when done.";

  const conversation = query({
    prompt,
    options: {
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "bureauflow-email-tools": emailMcp },
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
        `\n✅ Cleanup complete (${message.duration_ms}ms, $${message.total_cost_usd.toFixed(4)})`
      );
    }
  }
}

main().catch(console.error);
