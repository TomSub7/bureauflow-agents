/**
 * BureauFlow Lead Qualification Agent
 *
 * Monitors new signups, scores leads, and triggers follow-up actions:
 * 1. Scores leads based on trade, company size, signup source
 * 2. Sends personalized follow-up emails via Resend
 * 3. Alerts CEO for high-value leads (potential Business plan)
 * 4. Tracks conversion funnel metrics
 *
 * Usage: npx tsx src/lead-agent.ts
 *        npx tsx src/lead-agent.ts --check-lead "info@elektro-mueller.de"
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { fileURLToPath } from "node:url";
import {
  BUREAUFLOW_CONTEXT,
  OPS_EMAIL,
  CEO_EMAIL,
  SUPPORT_EMAIL,
  DEFAULT_MAX_TURNS,
  createAgentOptions,
} from "./config.js";

// ─── Lead Scoring Model ──────────────────────────────────────────────
// Points-based scoring aligned with BureauFlow ICP analysis
const TRADE_SCORES: Record<string, number> = {
  elektriker: 30,    // #1 ICP priority
  klempner: 25,      // #2 ICP priority
  shk: 25,           // Same as Klempner
  dachdecker: 20,    // #3
  maler: 15,         // #4
  schreiner: 15,     // #5
  tischler: 15,
  // Generic fallback
  handwerker: 10,
};

const SOURCE_SCORES: Record<string, number> = {
  demo_call: 35,     // Called the demo — very high intent
  direct: 25,        // Typed URL or saved bookmark
  linkedin: 20,      // LinkedIn outreach response
  whatsapp: 20,      // WhatsApp engagement
  sms: 15,           // SMS campaign response
  email: 10,         // Email campaign click-through
  organic: 10,       // Google/SEO
  referral: 30,      // Word of mouth — very high quality
};

// ─── Custom Tools ────────────────────────────────────────────────────

const scoreLead = tool(
  "score_lead",
  "Score a lead based on their signup data. Returns a score 0-100 and recommended action.",
  {
    email: z.string().email().describe("Lead's email address"),
    companyName: z.string().optional().describe("Company name if provided"),
    trade: z.string().optional().describe("Their trade/Gewerk (e.g., Elektriker, Klempner)"),
    source: z.string().optional().describe("How they found BureauFlow (e.g., demo_call, linkedin, organic)"),
    city: z.string().optional().describe("City if known"),
    employeeCount: z.number().optional().describe("Number of employees if known"),
  },
  async ({ email, companyName, trade, source, city, employeeCount }) => {
    let score = 0;
    const factors: string[] = [];

    // Trade score
    if (trade) {
      const tradeLower = trade.toLowerCase();
      const tradeScore = Object.entries(TRADE_SCORES).find(([key]) =>
        tradeLower.includes(key)
      )?.[1] ?? 5;
      score += tradeScore;
      factors.push(`Trade (${trade}): +${tradeScore}`);
    }

    // Source score
    if (source) {
      const srcLower = source.toLowerCase().replace(/[- ]/g, "_");
      const srcScore = SOURCE_SCORES[srcLower] ?? 5;
      score += srcScore;
      factors.push(`Source (${source}): +${srcScore}`);
    }

    // Company signals
    if (companyName) {
      score += 10;
      factors.push("Has company name: +10");
    }
    if (employeeCount && employeeCount > 5) {
      score += 15;
      factors.push(`${employeeCount} employees (>5): +15`);
    } else if (employeeCount && employeeCount > 1) {
      score += 5;
      factors.push(`${employeeCount} employees: +5`);
    }

    // Email domain signals (custom domain = more serious)
    const isCustomDomain = !email.match(/@(gmail|yahoo|hotmail|outlook|gmx|web\.de|t-online)/i);
    if (isCustomDomain) {
      score += 10;
      factors.push("Custom email domain: +10");
    }

    // Cap at 100
    score = Math.min(score, 100);

    // Determine tier
    let tier: "hot" | "warm" | "cold";
    let action: string;
    if (score >= 60) {
      tier = "hot";
      action = `ALERT CEO (${CEO_EMAIL}). Schedule demo call. Send personal follow-up.`;
    } else if (score >= 30) {
      tier = "warm";
      action = `Send automated follow-up sequence. Add to nurture campaign.`;
    } else {
      tier = "cold";
      action = `Add to general email list. Send welcome email only.`;
    }

    const result = {
      email,
      companyName: companyName ?? "unknown",
      score,
      tier,
      action,
      factors,
      recommendation:
        tier === "hot"
          ? "Tomas should personally reach out within 24h"
          : tier === "warm"
            ? "Automated nurture sequence with demo CTA"
            : "Welcome email + monthly newsletter only",
    };

    console.log(`\n[LEAD SCORE] ${email}: ${score}/100 (${tier.toUpperCase()})`);
    factors.forEach((f) => console.log(`  ${f}`));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

const draftFollowUp = tool(
  "draft_follow_up",
  "Draft a personalized follow-up email for a lead based on their score and profile",
  {
    email: z.string().email(),
    companyName: z.string().optional(),
    trade: z.string().optional(),
    tier: z.enum(["hot", "warm", "cold"]),
    score: z.number(),
  },
  async ({ email, companyName, trade, tier, score }) => {
    const company = companyName ?? "Ihr Unternehmen";
    const tradeLabel = trade ?? "Handwerksbetrieb";

    let subject: string;
    let body: string;

    if (tier === "hot") {
      subject = `${company} — Ihr persönlicher BureauFlow Ansprechpartner`;
      body = `Sehr geehrte Damen und Herren von ${company},

vielen Dank für Ihr Interesse an BureauFlow! Als ${tradeLabel} wissen Sie, wie wichtig es ist, keinen Anruf zu verpassen.

Ich bin Tomas Marty, Gründer von BureauFlow, und möchte Ihnen persönlich zeigen, wie unser KI-Telefonassistent speziell für ${tradeLabel} funktioniert.

Testen Sie unsere Demo: +49 158 886 583 28

Oder antworten Sie auf diese E-Mail — ich melde mich innerhalb von 24 Stunden bei Ihnen.

Mit freundlichen Grüßen,
Tomas Marty
Geschäftsführer, BureauFlow
+49 158 886 583 28`;
    } else if (tier === "warm") {
      subject = `Nie wieder verpasste Anrufe — BureauFlow für ${tradeLabel}`;
      body = `Hallo,

als ${tradeLabel} kennen Sie das Problem: Sie sind auf der Baustelle, das Telefon klingelt, und ein potenzieller Auftrag geht verloren.

BureauFlow löst das. Unsere KI beantwortet Ihre Anrufe auf Deutsch, nimmt Aufträge an und plant Termine — 24/7.

Jetzt 50% sparen mit Code GRUENDER50: https://bureauflow.de/register

Oder rufen Sie unsere Demo an: +49 158 886 583 28

Viele Grüße,
Das BureauFlow Team`;
    } else {
      subject = `Willkommen bei BureauFlow — Ihr KI-Telefonassistent`;
      body = `Hallo,

willkommen bei BureauFlow! Wir freuen uns, dass Sie sich registriert haben.

So starten Sie in 2 Minuten:
1. Dashboard öffnen: https://bureauflow.de/dashboard
2. Rufumleitung einrichten
3. Fertig — die KI beantwortet ab sofort Ihre Anrufe

Bei Fragen: ${SUPPORT_EMAIL}

Viele Grüße,
Das BureauFlow Team`;
    }

    console.log(`\n[DRAFT] Follow-up for ${email} (${tier}): "${subject}"`);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ email, subject, body, tier, score }),
        },
      ],
    };
  }
);

const checkRecentSignups = tool(
  "check_recent_signups",
  "Check for recent signups that haven't been qualified yet. In production, queries Neon DB.",
  {
    hoursBack: z.number().default(24).describe("How many hours back to check"),
  },
  async ({ hoursBack }) => {
    // In production: query Neon DB for users created in last N hours
    // where lead_score IS NULL or follow_up_sent = false
    console.log(`[DB] Checking signups from last ${hoursBack} hours...`);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            note: "Production: queries Neon DB for unqualified signups. Mock data for demo.",
            signups: [
              {
                email: "info@elektro-schmidt.de",
                name: "Elektro Schmidt",
                trade: "Elektriker",
                source: "linkedin",
                city: "Berlin",
                createdAt: new Date().toISOString(),
              },
              {
                email: "meister@dach-mueller.de",
                name: "Dachdeckerei Müller",
                trade: "Dachdecker",
                source: "organic",
                city: "München",
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        },
      ],
    };
  }
);

// ─── MCP Server ──────────────────────────────────────────────────────

export const leadMcp = createSdkMcpServer({
  name: "bureauflow-lead-tools",
  version: "1.0.0",
  tools: [scoreLead, draftFollowUp, checkRecentSignups],
});

// ─── System Prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are the BureauFlow Lead Qualification Agent.

IDENTITY:
- Purpose: Score, qualify, and nurture BureauFlow leads
- Language: English for internal operations, German for customer-facing content
- Style: Data-driven, efficient, business-focused

PRODUCT KNOWLEDGE:
${BUREAUFLOW_CONTEXT}

ICP PRIORITY ORDER:
1. Elektriker (highest value)
2. Klempner/SHK
3. Dachdecker
4. Maler
5. Schreiner

SCORING MODEL:
- Trade alignment: 5-30 points
- Signup source: 5-35 points (demo_call highest, organic lowest)
- Company name present: +10
- Custom email domain: +10
- Employee count >5: +15

TIERS:
- HOT (60+): Alert CEO immediately. Personal follow-up within 24h.
- WARM (30-59): Automated nurture sequence. Demo CTA.
- COLD (<30): Welcome email only. Monthly newsletter.

WORKFLOW:
1. Check for recent signups (check_recent_signups)
2. Score each lead (score_lead)
3. Draft appropriate follow-up (draft_follow_up)
4. For HOT leads: emphasize urgency — Tomas must see these
5. Report summary with conversion funnel metrics

RULES:
- NEVER skip a signup — every registration gets scored
- HOT leads get CEO attention. Period.
- Always use GRUENDER50 coupon in warm follow-ups
- Demo number (+49 158 886 583 28) in every customer email
- Alejandro Cruz Libreros is a BUSINESS PARTNER, not a lead
`.trim();

// ─── Run Agent ───────────────────────────────────────────────────────

async function main() {
  const specificLead = process.argv.find((a) => a.startsWith("--check-lead="))?.split("=")[1]
    ?? (process.argv.includes("--check-lead") ? process.argv[process.argv.indexOf("--check-lead") + 1] : null);

  console.log(`\n🎯 BureauFlow Lead Qualification Agent`);

  let prompt: string;

  if (specificLead) {
    console.log(`🔍 Checking specific lead: ${specificLead}\n`);
    prompt = `Score and qualify this specific lead: ${specificLead}. Use score_lead with whatever info you can infer from their email domain. Then draft an appropriate follow-up.`;
  } else {
    console.log(`📊 Running full qualification sweep\n`);
    prompt = `Run a complete lead qualification sweep:
1. Check recent signups from the last 24 hours
2. Score each one
3. Draft follow-up emails for each tier
4. Summarize the funnel: total signups, hot/warm/cold breakdown, recommended actions`;
  }

  const conversation = query({
    prompt,
    options: {
      ...createAgentOptions({
        agentName: "lead-agent",
        maxTurns: DEFAULT_MAX_TURNS,
        effort: "high", // Lead qualification deserves deeper reasoning
      }),
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "bureauflow-lead-tools": leadMcp },
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
        `\n✅ Qualification complete (${message.duration_ms}ms, $${message.total_cost_usd.toFixed(4)})`
      );
    }
  }
}

// Only run as a standalone CLI; importing this module must not auto-run it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
