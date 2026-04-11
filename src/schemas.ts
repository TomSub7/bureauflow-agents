/**
 * BureauFlow Agent Suite — Structured Output Schemas
 *
 * Zod schemas for structured agent outputs. Each agent can use these
 * with `outputFormat` to return typed, predictable JSON instead of
 * free-form text.
 *
 * Also exports raw JSON Schema versions for the SDK's `outputFormat` option.
 */

import { z } from "zod/v4";

// ─── Support Agent Result ───────────────────────────────────────────

export const SupportTicketResult = z.object({
  resolved: z.boolean().describe("Whether the support issue was fully resolved"),
  category: z
    .string()
    .describe("Issue category (e.g., billing, setup, feature, bug, general)"),
  escalated: z.boolean().describe("Whether the ticket was escalated to a human"),
  responseTime: z
    .number()
    .describe("Time in milliseconds from question to final answer"),
});

export type SupportTicketResult = z.infer<typeof SupportTicketResult>;

// ─── Email Cleanup Agent Result ─────────────────────────────────────

export const EmailCleanupResult = z.object({
  kept: z.number().describe("Number of emails kept in inbox"),
  archived: z.number().describe("Number of emails archived"),
  deleted: z.number().describe("Number of emails deleted"),
  topSpamSenders: z
    .array(z.string())
    .describe("Top spam/newsletter senders found during cleanup"),
});

export type EmailCleanupResult = z.infer<typeof EmailCleanupResult>;

// ─── Lead Qualification Agent Result ────────────────────────────────

export const LeadQualificationResult = z.object({
  totalScored: z.number().describe("Total number of leads scored"),
  hot: z.number().describe("Number of hot leads (score >= 60)"),
  warm: z.number().describe("Number of warm leads (score 30-59)"),
  cold: z.number().describe("Number of cold leads (score < 30)"),
  topLead: z
    .string()
    .describe("Email or company name of the highest-scored lead"),
});

export type LeadQualificationResult = z.infer<typeof LeadQualificationResult>;

// ─── JSON Schema exports for SDK outputFormat ───────────────────────
// The SDK's outputFormat requires plain JSON Schema objects, not Zod schemas.

export const SUPPORT_TICKET_JSON_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      resolved: { type: "boolean" },
      category: { type: "string" },
      escalated: { type: "boolean" },
      responseTime: { type: "number" },
    },
    required: ["resolved", "category", "escalated", "responseTime"],
    additionalProperties: false,
  },
};

export const EMAIL_CLEANUP_JSON_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      kept: { type: "number" },
      archived: { type: "number" },
      deleted: { type: "number" },
      topSpamSenders: { type: "array", items: { type: "string" } },
    },
    required: ["kept", "archived", "deleted", "topSpamSenders"],
    additionalProperties: false,
  },
};

export const LEAD_QUALIFICATION_JSON_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      totalScored: { type: "number" },
      hot: { type: "number" },
      warm: { type: "number" },
      cold: { type: "number" },
      topLead: { type: "string" },
    },
    required: ["totalScored", "hot", "warm", "cold", "topLead"],
    additionalProperties: false,
  },
};
