/**
 * BureauFlow Automation Map
 *
 * Single source of truth for all BureauFlow cron jobs and webhook endpoints.
 * Populated from vercel.json crons and known webhook integrations.
 *
 * Used by ops-agent.ts and monitor-agent.ts to inspect infrastructure state.
 */

// ─── Interfaces ─────────────────────────────────────────────────────

export interface CronJob {
  name: string;
  schedule: string;
  endpoint: string;
  description: string;
}

export interface WebhookEndpoint {
  name: string;
  path: string;
  provider: string;
}

// ─── Cron Jobs (from vercel.json) ───────────────────────────────────

export const CRON_JOBS: CronJob[] = [
  { name: "suppression-sync",     schedule: "0 6 * * *",         endpoint: "/api/cron/suppression-sync",     description: "Sync email suppression lists (bounces, complaints) with Resend" },
  { name: "daily-digest",         schedule: "30 6 * * *",        endpoint: "/api/cron/daily-digest",         description: "Send daily ops digest email summarizing CRM events and alerts" },
  { name: "fresh-leads-wave",     schedule: "35 5 * * *",        endpoint: "/api/cron/fresh-leads-wave",     description: "Send first-touch emails to newly enriched leads" },
  { name: "campaign-follow-ups",  schedule: "0 8 * * *",         endpoint: "/api/cron/campaign-follow-ups",  description: "Execute scheduled follow-up emails in active campaigns" },
  { name: "warm-reengagement",    schedule: "0 21 * * *",        endpoint: "/api/cron/warm-reengagement",    description: "Re-engage warm leads who haven't converted after initial outreach" },
  { name: "reply-monitor",        schedule: "0 */4 * * *",       endpoint: "/api/cron/reply-monitor",        description: "Check for email replies and update lead statuses every 4 hours" },
  { name: "trial-conversion",     schedule: "0 10 * * *",        endpoint: "/api/cron/trial-conversion",     description: "Nudge free-tier users approaching call limits toward paid plans" },
  { name: "setup-reminders",      schedule: "0 11 * * *",        endpoint: "/api/cron/setup-reminders",      description: "Remind registered users who haven't completed onboarding setup" },
  { name: "onboarding-milestones",schedule: "30 10 * * *",       endpoint: "/api/cron/onboarding-milestones",description: "Track and celebrate user onboarding milestone achievements" },
  { name: "booking-reminders",    schedule: "0 7 * * *",         endpoint: "/api/cron/booking-reminders",    description: "Send reminders for upcoming demo bookings" },
  { name: "enrich-leads",         schedule: "30 22 * * 1,4",     endpoint: "/api/cron/enrich-leads",         description: "Enrich new leads with company data (Mon+Thu evenings)" },
  { name: "review-requests",      schedule: "0 17 * * *",        endpoint: "/api/cron/review-requests",      description: "Ask satisfied customers for reviews on external platforms" },
  { name: "vapi-credit-monitor",  schedule: "0 */6 * * *",       endpoint: "/api/cron/vapi-credit-monitor",  description: "Check Vapi credit balance and alert if running low (every 6h)" },
  { name: "ai-insights",          schedule: "0 19 * * *",        endpoint: "/api/cron/ai-insights",          description: "Generate AI-powered insights from daily call and CRM data" },
  { name: "call-limit-alerts",    schedule: "0 */2 * * *",       endpoint: "/api/cron/call-limit-alerts",    description: "Alert users approaching their plan call limits (every 2h)" },
  { name: "competitor-watch",     schedule: "0 3 * * 1",         endpoint: "/api/cron/competitor-watch",     description: "Weekly competitor monitoring — pricing, feature, and SEO changes" },
  { name: "customer-success",     schedule: "0 7 * * *",         endpoint: "/api/cron/customer-success",     description: "Check customer health scores and flag at-risk accounts" },
  { name: "email-campaigns",      schedule: "0 7 * * *",         endpoint: "/api/cron/email-campaigns",      description: "Execute scheduled bulk email campaigns" },
  { name: "email-sequences",      schedule: "0 9 * * *",         endpoint: "/api/cron/email-sequences",      description: "Advance drip email sequences for enrolled contacts" },
  { name: "engagement-engine",    schedule: "0 8,13,18 * * *",   endpoint: "/api/cron/engagement-engine",    description: "Multi-channel engagement engine — runs 3x daily (8h, 13h, 18h)" },
  { name: "feedback-loops",       schedule: "0 23 * * *",        endpoint: "/api/cron/feedback-loops",       description: "Process feedback signals and update lead scoring models" },
  { name: "notification-digest",  schedule: "30 7 * * *",        endpoint: "/api/cron/notification-digest",  description: "Batch and send in-app notification digests to users" },
  { name: "outreach",             schedule: "0 8 * * *",         endpoint: "/api/cron/outreach",             description: "Execute cold outreach sequences to qualified prospects" },
  { name: "smart-sequences",      schedule: "30 8 * * *",        endpoint: "/api/cron/smart-sequences",      description: "AI-optimized sequence execution with send-time optimization" },
  { name: "wave-executor",        schedule: "30 5 * * *",        endpoint: "/api/cron/wave-executor",        description: "Execute multi-wave campaign batches (early morning)" },
  { name: "weekly-insights",      schedule: "0 19 * * 0",        endpoint: "/api/cron/weekly-insights",      description: "Generate and email weekly business insights report (Sundays)" },
  { name: "weekly-report",        schedule: "0 6 * * 1",         endpoint: "/api/cron/weekly-report",        description: "Compile and send weekly operations report (Mondays)" },
];

// ─── Webhook Endpoints ──────────────────────────────────────────────

export const WEBHOOKS: WebhookEndpoint[] = [
  { name: "stripe",  path: "/api/webhooks/stripe",  provider: "Stripe" },
  { name: "resend",  path: "/api/webhooks/resend",  provider: "Resend" },
  { name: "vapi",    path: "/api/webhooks/vapi",    provider: "Vapi" },
];

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Look up a cron job by exact or partial name match.
 */
export function getCronByName(name: string): CronJob | undefined {
  const lower = name.toLowerCase();
  return (
    CRON_JOBS.find((c) => c.name === lower) ??
    CRON_JOBS.find((c) => c.name.includes(lower))
  );
}

/**
 * Human-readable summary of the full automation landscape.
 */
export function getAutomationSummary(): string {
  const lines: string[] = [
    `BureauFlow Automation Map — ${CRON_JOBS.length} crons, ${WEBHOOKS.length} webhooks`,
    "",
    "=== CRON JOBS ===",
    ...CRON_JOBS.map(
      (c) => `  ${c.name.padEnd(24)} ${c.schedule.padEnd(20)} ${c.description}`
    ),
    "",
    "=== WEBHOOKS ===",
    ...WEBHOOKS.map(
      (w) => `  ${w.name.padEnd(12)} ${w.path.padEnd(28)} (${w.provider})`
    ),
  ];
  return lines.join("\n");
}
