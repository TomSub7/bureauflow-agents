/**
 * BureauFlow Support Agent
 *
 * Customer support agent for German tradespeople using BureauFlow.
 * Answers product questions, troubleshoots issues, and escalates
 * when human intervention is needed.
 *
 * Usage: npx tsx src/support-agent.ts "Wie funktioniert die Anrufweiterleitung?"
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
  DEFAULT_EFFORT,
  createAgentOptions,
} from "./config.js";

// ─── Custom MCP Tools ────────────────────────────────────────────────

const lookupFaq = tool(
  "lookup_faq",
  "Search BureauFlow FAQ knowledge base for answers to common customer questions about pricing, setup, features, and troubleshooting",
  { question: z.string().describe("The customer question to look up") },
  async ({ question }) => {
    // FAQ knowledge base — hardcoded for now, later can query Pinecone or DB
    const faqs: Record<string, string> = {
      pricing: "Free: 15 Anrufe/Monat. Starter: 59€/Monat (100 Anrufe). Pro: 129€/Monat (500 Anrufe). Business: 249€/Monat (unbegrenzt). Alle Pläne inkl. KI-Telefonassistent auf Deutsch.",
      setup: "1. Registrieren auf bureauflow.de 2. Telefonnummer einrichten (Weiterleitung oder neue Nummer) 3. Begrüßung anpassen 4. Fertig! Die KI beantwortet ab sofort Ihre Anrufe.",
      weiterleitung: "Richten Sie eine Rufumleitung bei Ihrem Telefonanbieter ein. Bei Nicht-Erreichbarkeit wird der Anruf an BureauFlow weitergeleitet. Ihre bestehende Nummer bleibt.",
      stornierung: "Kündigung jederzeit zum Monatsende möglich. Im Dashboard unter Einstellungen > Abo > Kündigen. Keine Mindestlaufzeit.",
      datenschutz: "Alle Daten werden DSGVO-konform in der EU gespeichert. Anrufaufzeichnungen nur mit Einverständnis. AV-Vertrag auf Anfrage.",
      demo: "Rufen Sie unsere Demo-Nummer an: +49 158 886 583 28. Die KI beantwortet Ihren Anruf live auf Deutsch.",
      gutschein: "GRUENDER50 = 50% auf den ersten Monat. Einfach bei der Registrierung eingeben.",
    };

    // Keyword/synonym matching. Customer questions arrive in German, so each
    // FAQ key carries a list of German (and a few English) trigger words. A
    // FAQ matches if the question contains the key itself or any synonym.
    const SYNONYMS: Record<string, string[]> = {
      pricing: ["preis", "preise", "kosten", "kostet", "tarif", "plan", "pläne", "euro", "€", "abo", "monatlich"],
      setup: ["einricht", "installation", "starten", "loslegen", "account", "registrier", "anmeld", "onboarding"],
      weiterleitung: ["weiterleit", "rufumleitung", "umleitung", "nummer", "anrufweiterleitung"],
      stornierung: ["kündig", "storno", "stornier", "beenden", "vertrag", "laufzeit"],
      datenschutz: ["dsgvo", "daten", "gdpr", "av-vertrag", "datenschutz", "privacy"],
      demo: ["demo", "test", "ausprobieren", "anrufen", "probe", "live"],
      gutschein: ["gutschein", "code", "rabatt", "gründer", "gruender", "gruender50", "sparen", "coupon"],
    };

    const q = question.toLowerCase();
    const matches = Object.entries(faqs)
      .filter(
        ([key]) =>
          q.includes(key) ||
          (SYNONYMS[key] ?? []).some((syn) => q.includes(syn))
      )
      .map(([key, answer]) => `[${key}] ${answer}`);

    // Fuzzy: if no direct match, return all FAQs for the agent to pick from
    if (matches.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No exact match for "${question}". Available topics:\n${Object.entries(faqs).map(([k, v]) => `• ${k}: ${v}`).join("\n")}`,
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: matches.join("\n\n") }],
    };
  }
);

const escalateToHuman = tool(
  "escalate_to_human",
  "Escalate a support ticket to the human team when the AI cannot resolve the issue. Use for billing disputes, technical bugs, or angry customers.",
  {
    reason: z.string().describe("Why this needs human attention"),
    customerEmail: z.string().email().optional().describe("Customer email if available"),
    priority: z.enum(["low", "medium", "high", "critical"]).describe("Urgency level"),
  },
  async ({ reason, customerEmail, priority }) => {
    const target = priority === "critical" ? CEO_EMAIL : OPS_EMAIL;
    const ticket = `TICKET-${Date.now().toString(36).toUpperCase()}`;

    console.log(`\n[ESCALATION] ${ticket}`);
    console.log(`  Priority: ${priority.toUpperCase()}`);
    console.log(`  Customer: ${customerEmail ?? "unknown"}`);
    console.log(`  Reason: ${reason}`);
    console.log(`  Routed to: ${target}\n`);

    return {
      content: [
        {
          type: "text" as const,
          text: `Ticket ${ticket} created (${priority}). Routed to ${target}. Customer will be contacted within ${priority === "critical" ? "1 hour" : "24 hours"}.`,
        },
      ],
    };
  }
);

const checkSubscriptionStatus = tool(
  "check_subscription",
  "Check a customer's subscription status by their email address",
  { email: z.string().email().describe("Customer email to look up") },
  async ({ email }) => {
    // In production, this would query Neon DB via Prisma
    // For now, return a mock response showing the structure
    console.log(`[DB LOOKUP] Checking subscription for ${email}`);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            note: "Production: queries Neon DB. Mock response for demo.",
            email,
            plan: "starter",
            status: "active",
            callsUsed: 42,
            callsLimit: 100,
            nextBilling: "2026-05-01",
            coupon: null,
          }),
        },
      ],
    };
  }
);

// ─── MCP Server (in-process) ─────────────────────────────────────────

export const supportMcp = createSdkMcpServer({
  name: "bureauflow-support-tools",
  version: "1.0.0",
  tools: [lookupFaq, escalateToHuman, checkSubscriptionStatus],
});

// ─── System Prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `
Du bist der BureauFlow Kundensupport-Agent.

IDENTITÄT:
- Name: BureauFlow Support
- Sprache: Deutsch (du/Sie je nach Kundenvorliebe, Standard = Sie)
- Ton: Freundlich, kompetent, lösungsorientiert
- Du kennst das Produkt perfekt und antwortest wie ein Handwerker-Spezialist

PRODUKTWISSEN:
${BUREAUFLOW_CONTEXT}

REGELN:
1. Antworte IMMER auf Deutsch, auch wenn die Frage auf Englisch kommt
2. ALWAYS use lookup_faq tool FIRST before answering any question. ALWAYS use check_subscription when a customer mentions their account.
3. Bei technischen Problemen: erst FAQ durchsuchen (lookup_faq), dann troubleshooten
4. Bei Abrechnungsproblemen oder wütenden Kunden: sofort eskalieren (escalate_to_human)
5. Wenn du die Antwort nicht weißt: ehrlich sagen und an ${SUPPORT_EMAIL} verweisen
6. Erwähne immer die Demo-Nummer (+49 158 886 583 28) wenn es passt
7. Verwende den Gutscheincode GRUENDER50 bei Neukunden
8. Keine Rabatte über 50% versprechen — das kann nur der CEO genehmigen

ABLAUF:
1. Frage verstehen
2. FAQ durchsuchen
3. Abo-Status prüfen wenn relevant
4. Klare Antwort geben
5. Bei Bedarf eskalieren
`.trim();

// ─── Run Agent ───────────────────────────────────────────────────────

async function main() {
  const userQuestion = process.argv.slice(2).join(" ");

  if (!userQuestion) {
    console.log("Usage: npx tsx src/support-agent.ts \"<Kundenfrage>\"");
    console.log("Example: npx tsx src/support-agent.ts \"Was kostet BureauFlow?\"");
    process.exit(1);
  }

  console.log(`\n🎧 BureauFlow Support Agent`);
  console.log(`📨 Frage: ${userQuestion}\n`);

  const conversation = query({
    prompt: userQuestion,
    options: {
      ...createAgentOptions({
        agentName: "support-agent",
        maxTurns: DEFAULT_MAX_TURNS,
        effort: DEFAULT_EFFORT,
      }),
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "bureauflow-support-tools": supportMcp },
      tools: [], // No built-in tools — only our MCP
    },
  });

  for await (const message of conversation) {
    if (message.type === "assistant") {
      // Extract text from the assistant message content blocks
      for (const block of message.message.content) {
        if ("text" in block && block.text) {
          console.log(block.text);
        }
      }
    } else if (message.type === "result") {
      console.log(`\n✅ Done (${message.duration_ms}ms, $${message.total_cost_usd.toFixed(4)})`);
    }
  }
}

// Only run as a standalone CLI; importing this module (e.g. from jarvis.ts)
// must not trigger a full agent run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
