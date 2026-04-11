/**
 * BureauFlow Agent Suite — Shared Configuration
 *
 * Centralizes all agent config: model selection, BureauFlow product knowledge,
 * shared constants, and the `createAgentOptions()` helper that bundles hooks,
 * effort, model, permissionMode, and persistSession so every agent gets the
 * same smart defaults without repeating boilerplate.
 */

import type {
  HookCallbackMatcher,
  HookEvent,
  EffortLevel,
  OutputFormat,
} from "@anthropic-ai/claude-agent-sdk";
import { createAgentHooks } from "./hooks.js";

// ─── Model ───────────────────────────────────────────────────────────
export const MODEL = "claude-sonnet-4-6";

// ─── BureauFlow Product Knowledge ────────────────────────────────────
// Injected into every agent's system prompt so they know the product cold.
export const BUREAUFLOW_CONTEXT = `
BureauFlow ist ein KI-Telefonassistent für deutsche Handwerksbetriebe.
- Zielgruppe: Elektriker, Klempner/SHK, Dachdecker, Maler, Schreiner
- Preise: Free (15 Anrufe), Starter 59 €/mo, Pro 129 €/mo, Business 249 €/mo
- Kernfeature: KI beantwortet Anrufe auf Deutsch, nimmt Aufträge an, plant Termine
- Demo-Nummer: +49 158 886 583 28
- Website: https://bureauflow.de
- Firma: Bureao Flow GmbH, Trimmelter Weg 1a, 54295 Trier
- USt-IdNr: DE346874906
- Gründer: Tomas Marty (CEO)

Wettbewerber:
- Fonio (€99/mo) — teurer, kein Handwerk-Fokus
- HalloPetra (€99-499/mo) — nur SHK
- meiti (~€42/mo) — nur Voicemail, keine Live-KI
- IONOS AI (€19-199/mo) — generisch, nicht branchenspezifisch

BureauFlow = einziger bezahlbarer (<€99) + Handwerker-spezialisierter + Live-KI Assistent.
`.trim();

// ─── Email addresses ─────────────────────────────────────────────────
export const OPS_EMAIL = "ops@bureauflow.de";
export const CEO_EMAIL = "tomasmarty@bureauflow.io";
export const SUPPORT_EMAIL = "info@bureauflow.de";

// ─── Neon DB connection (read from env) ──────────────────────────────
export const DATABASE_URL = process.env.DATABASE_URL ?? "";

// ─── Resend API key ──────────────────────────────────────────────────
export const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";

// ─── Vapi config ─────────────────────────────────────────────────────
export const VAPI_API_KEY = process.env.VAPI_API_KEY ?? "";
export const DEMO_PHONE = "+4915888658328";

// ─── Agent execution defaults ────────────────────────────────────────
export const DEFAULT_MAX_TURNS = 15;
export const DEFAULT_EFFORT: "medium" | "high" = "medium";

// ─── createAgentOptions() Helper ────────────────────────────────────
// Bundles hooks, effort, model, permissionMode, and persistSession so
// all agents can call `createAgentOptions({ maxTurns: 15 })` instead of
// repeating the same options block.

export interface AgentOptionsOverrides {
  /** Agent name used in hook logs and metrics. Defaults to "bureauflow-agent". */
  agentName?: string;
  /** Max conversation turns. Defaults to DEFAULT_MAX_TURNS. */
  maxTurns?: number;
  /** Reasoning effort level. Defaults to DEFAULT_EFFORT. */
  effort?: EffortLevel;
  /** Model override. Defaults to MODEL. */
  model?: string;
  /** Whether to persist the session to disk. Defaults to false. */
  persistSession?: boolean;
  /** Structured output format. Optional. */
  outputFormat?: OutputFormat;
  /** Additional hooks to merge on top of the defaults. */
  extraHooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}

export interface AgentOptions {
  model: string;
  effort: EffortLevel;
  permissionMode: "bypassPermissions";
  allowDangerouslySkipPermissions: true;
  persistSession: boolean;
  maxTurns: number;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  outputFormat?: OutputFormat;
  includeHookEvents: boolean;
}

/**
 * Create a fully-configured options object for a BureauFlow agent.
 *
 * @example
 * ```ts
 * const opts = createAgentOptions({ agentName: "support-agent", maxTurns: 10 });
 * const conversation = query({
 *   prompt: userQuestion,
 *   options: { ...opts, systemPrompt: SYSTEM_PROMPT, mcpServers, tools: [] },
 * });
 * ```
 */
export function createAgentOptions(
  overrides: AgentOptionsOverrides = {}
): AgentOptions {
  const agentName = overrides.agentName ?? "bureauflow-agent";

  // Build base hooks from our hook system
  const baseHooks = createAgentHooks(agentName);

  // Merge extra hooks if provided
  const mergedHooks = { ...baseHooks };
  if (overrides.extraHooks) {
    for (const [event, matchers] of Object.entries(overrides.extraHooks)) {
      const key = event as HookEvent;
      const existing = mergedHooks[key] ?? [];
      mergedHooks[key] = [...existing, ...matchers];
    }
  }

  const opts: AgentOptions = {
    model: overrides.model ?? MODEL,
    effort: overrides.effort ?? DEFAULT_EFFORT,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: overrides.persistSession ?? false,
    maxTurns: overrides.maxTurns ?? DEFAULT_MAX_TURNS,
    hooks: mergedHooks,
    includeHookEvents: true,
  };

  if (overrides.outputFormat) {
    opts.outputFormat = overrides.outputFormat;
  }

  return opts;
}

// ─── Lessons Learned ─────────────────────────────────────────────────
// Core rules derived from real failures. Injected into agent prompts.
export const AGENT_RULES = `
CORE RULES (from real failures — NEVER repeat):
0. PRODUCT-WORKS-FIRST (LESSON ZERO): Before diagnosing why there are 0 customers, VERIFY the signup/payment flow works end-to-end. BureauFlow's /register was broken with 504 errors for 6 WEEKS (Feb 17 - Apr 9). Every agent blamed marketing/sales while the product literally didn't work. The product has only been functional since April 9. ALWAYS check the product first.
1. PLATFORM-FIRST: Before building ANY tool, check if the platform already has a built-in feature.
2. REVENUE-FIRST AT SCALE ZERO: Until customer #1, every action must answer "Will this generate revenue this week?"
3. CHECK-BEFORE-ALERT: Consult data/completed-tasks.json before flagging issues. Don't re-alert on solved problems.
4. MULTI-SOURCE VERIFICATION: When checking if something was done, state which sources were checked and flag blind spots.
5. NO-SELF-REFERENCE: Monitoring agents must exclude their own previous outputs from analysis.
6. NEVER-IDLE: After completing a task, immediately start the next highest-impact action. Never ask "what's next?"
7. Read data/lessons-learned.json for the full lesson database with root causes and correct approaches.
`.trim();
