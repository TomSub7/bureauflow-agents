/**
 * BureauFlow Agent Suite — External MCP Server Connectors
 *
 * Configures connections to real external MCP servers so agents can access
 * live data (Gmail, Google Calendar, Stripe) instead of only using
 * in-process mock tools.
 *
 * Each connector reads credentials from environment variables.
 * See .env.example for required values.
 *
 * Usage:
 *   import { GMAIL_MCP, GOOGLE_CALENDAR_MCP, STRIPE_MCP } from "./mcp-connectors.js";
 *
 *   // Pass as mcpServers to query():
 *   query({
 *     options: {
 *       mcpServers: {
 *         "gmail": GMAIL_MCP,
 *         "my-sdk-tools": myLocalMcp,
 *       },
 *     },
 *   });
 */

import type {
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";

// ─── Gmail MCP ──────────────────────────────────────────────────────
//
// Uses the open-source mcp-mail-server package over IMAP/SMTP.
// Tools provided: search_all_messages, get_messages, get_recent_messages,
//   get_unseen_messages, search_by_sender, search_by_subject,
//   search_by_body, send_email, reply_to_email, list_mailboxes, etc.
//
// Intended for: email-agent (inbox scanning, classification with real data)
//
export function createGmailMcp(): McpStdioServerConfig {
  const user = process.env.GMAIL_IMAP_USER;
  const pass = process.env.GMAIL_IMAP_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error(
      "Gmail MCP requires GMAIL_IMAP_USER and GMAIL_IMAP_APP_PASSWORD env vars. " +
      "Generate an App Password at https://myaccount.google.com/apppasswords"
    );
  }

  return {
    type: "stdio",
    command: "npx",
    args: ["-y", "mcp-mail-server"],
    env: {
      IMAP_HOST: "imap.gmail.com",
      IMAP_PORT: "993",
      IMAP_SECURE: "true",
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "587",
      SMTP_SECURE: "true",
      EMAIL_USER: user,
      EMAIL_PASS: pass,
    },
  };
}

// ─── Google Calendar MCP ────────────────────────────────────────────
//
// Uses the @anthropic-ai/claude-code-google-calendar MCP server.
// Tools provided: gcal_list_calendars, gcal_list_events, gcal_create_event,
//   gcal_update_event, gcal_delete_event, gcal_find_free_time,
//   gcal_find_meeting_times, gcal_respond_to_event.
//
// Intended for: support-agent (check appointment availability, book demos)
//
export function createGoogleCalendarMcp(): McpStdioServerConfig {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Calendar MCP requires GOOGLE_OAUTH_CLIENT_ID, " +
      "GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REFRESH_TOKEN env vars. " +
      "Create OAuth credentials at https://console.cloud.google.com/apis/credentials"
    );
  }

  return {
    type: "stdio",
    command: "npx",
    args: ["-y", "@anthropic-ai/claude-code-google-calendar"],
    env: {
      GOOGLE_OAUTH_CLIENT_ID: clientId,
      GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
      GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken,
    },
  };
}

// ─── Stripe MCP ─────────────────────────────────────────────────────
//
// Uses the official @stripe/mcp-server package (stdio transport).
// Tools provided: list_customers, get_customer, list_subscriptions,
//   list_invoices, list_payment_intents, get_balance, search_customers,
//   list_charges, and more.
//
// Intended for: lead-agent (check if lead is already a paying customer,
//   verify subscription status, payment history)
//
export function createStripeMcp(): McpStdioServerConfig {
  const apiKey = process.env.STRIPE_SECRET_KEY;

  if (!apiKey) {
    throw new Error(
      "Stripe MCP requires STRIPE_SECRET_KEY env var. " +
      "Get your key from https://dashboard.stripe.com/apikeys"
    );
  }

  return {
    type: "stdio",
    command: "npx",
    args: ["-y", "@stripe/mcp", "--tools=all"],
    env: {
      STRIPE_SECRET_KEY: apiKey,
    },
  };
}

// ─── Composio MCP (HTTP) ────────────────────────────────────────────
//
// Composio provides a unified HTTP MCP gateway for 500+ apps.
// BureauFlow workspace (tomasmarty_workspace) has these connected:
//   Gmail, Outlook, Slack, Google Sheets, Stripe, Twitter, Reddit,
//   GA, GSC, GDrive, GCal.
//
// Tools provided (via COMPOSIO_SEARCH_TOOLS): varies by connected app.
// Useful as a fallback when dedicated MCP servers are not configured.
//
// Intended for: any agent needing broad cross-app access
//
export function createComposioMcp(): McpHttpServerConfig {
  const url = process.env.COMPOSIO_MCP_URL;
  const apiKey = process.env.COMPOSIO_API_KEY;

  if (!url || !apiKey) {
    throw new Error(
      "Composio MCP requires COMPOSIO_MCP_URL and COMPOSIO_API_KEY env vars. " +
      "Get these from https://app.composio.dev/settings"
    );
  }

  return {
    type: "http",
    url,
    headers: {
      "x-api-key": apiKey,
    },
  };
}

// ─── Helper: Build MCP server map from available env vars ───────────
//
// Returns only the connectors whose env vars are present.
// Agents can call this to get all available external MCP servers
// without crashing if some credentials are missing.
//
export function getAvailableMcpServers(): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  try {
    servers["gmail"] = createGmailMcp();
  } catch {
    // Gmail env vars not configured — skip
  }

  try {
    servers["google-calendar"] = createGoogleCalendarMcp();
  } catch {
    // Google Calendar env vars not configured — skip
  }

  try {
    servers["stripe"] = createStripeMcp();
  } catch {
    // Stripe env vars not configured — skip
  }

  try {
    servers["composio"] = createComposioMcp();
  } catch {
    // Composio env vars not configured — skip
  }

  return servers;
}
