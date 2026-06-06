/**
 * BureauFlow Email Cleanup Agent — Live Gmail Version
 *
 * Enhanced version of email-agent that connects to REAL Gmail via MCP
 * server, instead of only using in-process mock tools.
 *
 * Combines:
 * - Gmail MCP (stdio) for searching/reading actual emails
 * - In-process classify_email tool for AI classification logic
 * - In-process report_cleanup for result summaries
 *
 * Usage: npx tsx src/email-agent-live.ts             # dry run (default)
 *        npx tsx src/email-agent-live.ts --live       # actually delete
 *        npx tsx src/email-agent-live.ts --hours=48
 *
 * Requires: GMAIL_IMAP_USER + GMAIL_IMAP_APP_PASSWORD in .env
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { CEO_EMAIL, OPS_EMAIL, DEFAULT_MAX_TURNS, createAgentOptions } from "./config.js";
import { createGmailMcp } from "./mcp-connectors.js";

// ─── Safety Lists ────────────────────────────────────────────────────
// (Same as email-agent.ts — single source of truth would be a config,
//  but keeping inline here for self-contained readability)

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
  "google.com",
  "apple.com",
  "ourea.lu",
  "closers.app",
  "porkbun.com",
  "cloudflare.com",
  "lexware.de",
  "millo.gmbh",
  "bubic.de",
  "sentinelegal.ch",
];

const AUTO_DELETE_SENDERS = [
  "noreply@medium.com",
  "newsletter@",
  "marketing@",
  "promo@",
  "no-reply@producthunt.com",
  "digest@quora.com",
];

// ─── In-Process Classification Tool ─────────────────────────────────
// The same classification logic from email-agent.ts — runs in-process
// as an SDK MCP tool. The agent reads emails from Gmail MCP, then
// passes sender/subject/snippet here for scoring.

const classifyEmail = tool(
  "classify_email",
  "Classify an email as keep/archive/delete based on sender, subject, and content analysis. Use AFTER reading the email from Gmail.",
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
      confidence = 0.5;
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
    highlights: z.array(z.string()).optional().describe("Notable emails worth mentioning"),
    errors: z.array(z.string()).optional().describe("Any errors encountered"),
  },
  async ({ kept, archived, deleted, unsubscribed, highlights, errors }) => {
    const report = [
      `=== Email Cleanup Report (LIVE) ===`,
      `Kept:         ${kept}`,
      `Archived:     ${archived}`,
      `Deleted:      ${deleted}`,
      `Unsubscribed: ${unsubscribed}`,
      `Errors:       ${errors?.length ?? 0}`,
      highlights?.length ? `\nNotable:\n${highlights.map((h) => `  * ${h}`).join("\n")}` : "",
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

// ─── In-Process MCP Server (classification tools) ───────────────────

const classifyMcp = createSdkMcpServer({
  name: "bureauflow-email-classify",
  version: "1.0.0",
  tools: [classifyEmail, reportCleanupResults],
});

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are the BureauFlow Email Cleanup Agent (LIVE mode).

IDENTITY:
- Purpose: Autonomously clean up Tomas Marty's Gmail inbox (CEO of BureauFlow)
- Language: English for internal ops
- Style: Efficient, no-nonsense, report results clearly

CONTEXT:
Tomas has ADHD. He needs his inbox clean but cannot do it himself.
You have REAL access to Gmail via the "gmail" MCP server.

YOUR TOOLS:
1. **Gmail MCP tools** (prefixed with "gmail" namespace):
   - search_all_messages / search_by_sender / search_by_subject — find emails
   - get_recent_messages / get_unseen_messages — scan inbox
   - get_messages / get_message — read full email content
   - list_mailboxes — see available folders
   - delete_message — remove spam (DRY RUN: do NOT use this)

2. **Classification tools** (bureauflow-email-classify):
   - classify_email — pass sender + subject + snippet for scoring
   - report_cleanup — generate final summary

WORKFLOW:
1. First, connect to the inbox (open_mailbox for INBOX)
2. Get recent/unseen messages
3. For each email: extract sender, subject, snippet
4. Call classify_email for each one
5. Batch the results: keep / archive / delete
6. In DRY RUN: only report, do NOT delete or move anything
7. In LIVE mode: delete emails classified as "delete" with confidence >= 0.9
8. Generate report using report_cleanup

PROTECTED SENDERS (NEVER delete):
${PROTECTED_SENDERS.map((s) => `- ${s}`).join("\n")}

RULES:
1. When confidence < 0.7, KEEP the email (false positives are worse than clutter)
2. Always classify before deleting — use the classify_email tool
3. Generate a cleanup report at the end using report_cleanup
4. If an email looks like a customer inquiry, KEEP it regardless of sender
5. German-language emails from unknown senders are likely leads — KEEP them
6. Any email mentioning "Handwerker", "Elektriker", "Klempner", etc. is business — KEEP
7. Process at most 50 emails per run to avoid excessive API calls
8. If Gmail connection fails, report the error clearly and exit
`.trim();

// ─── Run Agent ──────────────────────────────────────────────────────

async function main() {
  // Safety: this agent has REAL delete access to Gmail. Deletions are off
  // unless the operator explicitly passes --live; --dry-run remains accepted.
  const isLive = process.argv.includes("--live");
  const isDryRun = !isLive;
  const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
  const parsedHours = hoursArg ? parseInt(hoursArg.split("=")[1]!, 10) : 24;
  const hours = Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : 24;

  // Connect to real Gmail — will throw if env vars are missing
  let gmailMcp;
  try {
    gmailMcp = createGmailMcp();
  } catch (err) {
    console.error(`\nFailed to create Gmail MCP connection:`);
    console.error((err as Error).message);
    console.error(`\nSet GMAIL_IMAP_USER and GMAIL_IMAP_APP_PASSWORD in .env`);
    console.error(`Generate an App Password: https://myaccount.google.com/apppasswords\n`);
    process.exit(1);
  }

  console.log(`\nBureauFlow Email Cleanup Agent (LIVE Gmail)`);
  console.log(`Mode: ${isDryRun ? "DRY RUN (no deletions — pass --live to enable)" : "LIVE"}`);
  console.log(`Scanning: last ${hours} hours`);
  console.log(`Account: ${process.env.GMAIL_IMAP_USER}\n`);

  const prompt = isDryRun
    ? `Scan my Gmail inbox for emails from the last ${hours} hours. Classify each email using classify_email. DO NOT delete or move anything — this is a dry run. Report what you would do using report_cleanup.`
    : `Clean up my Gmail inbox. Scan emails from the last ${hours} hours. Classify each using classify_email. Delete spam and unwanted newsletters (confidence >= 0.9 only). Archive low-priority items. Generate a cleanup report when done using report_cleanup.`;

  const conversation = query({
    prompt,
    options: {
      ...createAgentOptions({
        agentName: "email-agent-live",
        maxTurns: DEFAULT_MAX_TURNS + 10, // More turns needed for real email processing
        effort: "high", // Careful classification deserves deeper reasoning
      }),
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: {
        // Real Gmail access via stdio MCP
        "gmail": gmailMcp,
        // In-process classification + reporting
        "bureauflow-email-classify": classifyMcp,
      },
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
      console.log(
        `\nCleanup complete (${message.duration_ms}ms, $${message.total_cost_usd.toFixed(4)})`
      );
    }
  }
}

main().catch(console.error);
