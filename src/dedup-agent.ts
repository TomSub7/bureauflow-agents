/**
 * BureauFlow Dedup Agent — Redundancy Detection & Task History
 *
 * The "project historian" that prevents agents from rediscovering and
 * re-analyzing issues that were already fixed in previous sessions.
 *
 * Maintains a task completion log and provides tools for other agents
 * to check before acting:
 * - check_if_done — fuzzy-match against completed tasks
 * - mark_as_done — log a completed task
 * - list_completed — list all completed tasks, optionally since a date
 * - find_redundancies — flag which proposed tasks are already done
 *
 * Usage: npx tsx src/dedup-agent.ts
 *        npx tsx src/dedup-agent.ts "Check if secret rotation was already done"
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { MODEL, BUREAUFLOW_CONTEXT, CEO_EMAIL, OPS_EMAIL, DEFAULT_MAX_TURNS } from "./config.js";

// ─── Data File Path ─────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = resolve(__dirname, "..", "data", "completed-tasks.json");

// ─── Types ──────────────────────────────────────────────────────────

interface CompletedTask {
  id: string;
  description: string;
  completedAt: string;
  status: "done" | "partial" | "reverted";
  tags?: string[];
}

interface TaskStore {
  tasks: CompletedTask[];
}

// ─── Persistence Helpers ────────────────────────────────────────────

function loadTasks(): TaskStore {
  if (!existsSync(DATA_PATH)) {
    return { tasks: [] };
  }
  const raw = readFileSync(DATA_PATH, "utf-8");
  return JSON.parse(raw) as TaskStore;
}

function saveTasks(store: TaskStore): void {
  writeFileSync(DATA_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// ─── Fuzzy Matching ─────────────────────────────────────────────────
// Simple token-overlap similarity. Splits descriptions into lowercase
// tokens and computes Jaccard similarity. A match above 0.3 is flagged
// as a potential duplicate (conservative threshold to catch rephrased tasks).

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s-]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function fuzzyMatch(
  needle: string,
  tasks: CompletedTask[],
  threshold = 0.3
): { isDuplicate: boolean; matchingTask: CompletedTask | null; similarity: number } {
  const needleTokens = tokenize(needle);
  let bestMatch: CompletedTask | null = null;
  let bestScore = 0;

  for (const task of tasks) {
    // Check description similarity
    const descTokens = tokenize(task.description);
    const descScore = jaccardSimilarity(needleTokens, descTokens);

    // Also check tag overlap — tags are single words, so match against needle tokens
    let tagBoost = 0;
    if (task.tags) {
      const tagSet = new Set(task.tags.map((t) => t.toLowerCase()));
      let tagHits = 0;
      for (const token of needleTokens) {
        if (tagSet.has(token)) tagHits++;
      }
      tagBoost = tagSet.size > 0 ? (tagHits / tagSet.size) * 0.2 : 0;
    }

    const combined = descScore + tagBoost;
    if (combined > bestScore) {
      bestScore = combined;
      bestMatch = task;
    }
  }

  return {
    isDuplicate: bestScore >= threshold,
    matchingTask: bestScore >= threshold ? bestMatch : null,
    similarity: Math.round(bestScore * 100) / 100,
  };
}

// ─── Tools ──────────────────────────────────────────────────────────

const checkIfDone = tool(
  "check_if_done",
  "Fuzzy-match a task description against completed tasks to detect if work was already done. Returns isDuplicate=true if a match is found above the similarity threshold.",
  {
    taskDescription: z
      .string()
      .describe("Description of the task to check (e.g., 'Rotate Stripe API keys')"),
    threshold: z
      .number()
      .optional()
      .describe("Similarity threshold 0-1 (default 0.3). Lower = more aggressive matching."),
  },
  async ({ taskDescription, threshold }) => {
    const store = loadTasks();
    const result = fuzzyMatch(taskDescription, store.tasks, threshold ?? 0.3);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            query: taskDescription,
            ...result,
            totalTasksChecked: store.tasks.length,
          }),
        },
      ],
    };
  }
);

const markAsDone = tool(
  "mark_as_done",
  "Log a task as completed in the persistent task store. Call this after any meaningful work is finished so future sessions know it was done.",
  {
    taskId: z
      .string()
      .describe("Unique kebab-case identifier (e.g., 'secret-rotation-2026-04-11')"),
    description: z.string().describe("Human-readable description of what was done"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Keyword tags for improved matching (e.g., ['security', 'stripe', 'secrets'])"),
    status: z
      .enum(["done", "partial", "reverted"])
      .optional()
      .describe("Task status (default: done)"),
  },
  async ({ taskId, description, tags, status }) => {
    const store = loadTasks();

    // Check for existing task with same ID
    const existingIdx = store.tasks.findIndex((t) => t.id === taskId);
    const newTask: CompletedTask = {
      id: taskId,
      description,
      completedAt: new Date().toISOString().split("T")[0],
      status: status ?? "done",
      tags,
    };

    if (existingIdx >= 0) {
      store.tasks[existingIdx] = newTask;
    } else {
      store.tasks.push(newTask);
    }

    saveTasks(store);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            action: existingIdx >= 0 ? "updated" : "created",
            task: newTask,
            totalTasks: store.tasks.length,
          }),
        },
      ],
    };
  }
);

const listCompleted = tool(
  "list_completed",
  "List all completed tasks, optionally filtered to those completed since a given date.",
  {
    since: z
      .string()
      .optional()
      .describe("ISO date string (e.g., '2026-04-01'). Only return tasks completed on or after this date."),
    tag: z
      .string()
      .optional()
      .describe("Filter by tag (e.g., 'security'). Only return tasks with this tag."),
  },
  async ({ since, tag }) => {
    const store = loadTasks();
    let filtered = store.tasks;

    if (since) {
      filtered = filtered.filter((t) => t.completedAt >= since);
    }
    if (tag) {
      const tagLower = tag.toLowerCase();
      filtered = filtered.filter((t) => t.tags?.some((tg) => tg.toLowerCase() === tagLower));
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            total: filtered.length,
            since: since ?? "all-time",
            tag: tag ?? "all",
            tasks: filtered,
          }),
        },
      ],
    };
  }
);

const findRedundancies = tool(
  "find_redundancies",
  "Take a list of proposed tasks and flag which ones are already done. Returns each proposed task annotated with isDuplicate and the matching completed task if found.",
  {
    proposedTasks: z
      .array(z.string())
      .describe("List of task descriptions to check against the completion log"),
    threshold: z
      .number()
      .optional()
      .describe("Similarity threshold 0-1 (default 0.3)"),
  },
  async ({ proposedTasks, threshold }) => {
    const store = loadTasks();
    const results = proposedTasks.map((desc) => {
      const match = fuzzyMatch(desc, store.tasks, threshold ?? 0.3);
      return {
        proposed: desc,
        ...match,
      };
    });

    const redundant = results.filter((r) => r.isDuplicate);
    const novel = results.filter((r) => !r.isDuplicate);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            summary: {
              totalProposed: proposedTasks.length,
              redundant: redundant.length,
              novel: novel.length,
            },
            redundant,
            novel,
          }),
        },
      ],
    };
  }
);

// ─── MCP Server ─────────────────────────────────────────────────────

export const dedupMcp = createSdkMcpServer({
  name: "bureauflow-dedup-tools",
  version: "1.0.0",
  tools: [checkIfDone, markAsDone, listCompleted, findRedundancies],
});

// ─── Memory File Path ───────────────────────────────────────────────
// Read MEMORY.md at startup to enrich the system prompt with current state.

const MEMORY_DIR = resolve(
  process.env.HOME ?? "~",
  ".claude",
  "projects",
  "-Users-tomasmarty",
  "memory"
);

function loadMemorySummary(): string {
  const memoryPath = resolve(MEMORY_DIR, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    return "(MEMORY.md not found — operating without project memory)";
  }
  const raw = readFileSync(memoryPath, "utf-8");
  // Extract key sections for the system prompt (first 3000 chars to stay within limits)
  return raw.slice(0, 3000);
}

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are the BureauFlow Dedup Agent — the project historian and redundancy detector.

IDENTITY:
- Purpose: Prevent agents and sessions from rediscovering and re-analyzing issues that were already fixed
- Role: FIRST agent consulted before any work begins
- Language: English for internal ops
- Style: Factual, precise, reference specific dates and task IDs

PRODUCT KNOWLEDGE:
${BUREAUFLOW_CONTEXT}

WHY YOU EXIST:
Tomas (CEO) has ADHD. Claude keeps rediscovering the same issues across sessions:
- Secret rotation that was already done last week gets flagged again
- iCloud app-specific password setup keeps being suggested
- Same spam senders searched without checking if they were already deleted
This wastes time and erodes trust. You stop this.

CURRENT PROJECT MEMORY:
${loadMemorySummary()}

YOUR TOOLS:
1. check_if_done — Fuzzy-match a task description against completed tasks
2. mark_as_done — Log a completed task for future reference
3. list_completed — List completed tasks with optional date/tag filters
4. find_redundancies — Batch-check proposed tasks against the completion log

WORKFLOW:
1. When consulted, ALWAYS check the task log first
2. If a task was already done, report: "REDUNDANT — [task ID] completed on [date]: [description]"
3. If a task is novel, report: "NOVEL — no prior completion found for: [description]"
4. When marking tasks done, use descriptive IDs and relevant tags for future matching
5. Periodically suggest pruning very old tasks (>90 days) that are no longer relevant

RULES:
- NEVER skip the dedup check — that is your entire purpose
- Be aggressive about catching rephrased duplicates (use low threshold when uncertain)
- When in doubt, flag as potential duplicate and let the caller decide
- Include the completion date so Tomas knows how recently it was done

LESSONS LEARNED (from real failures — NEVER repeat these):
1. MULTI-SOURCE VERIFICATION: Tomas has 4 email accounts (Gmail, iCloud, Hotmail, Closers). When checking if emails were sent, state WHICH accounts you checked and flag blind spots. Never say "NOT SENT" if you only checked one account.
2. CHECK-BEFORE-ALERT: Before flagging any issue, check completed-tasks.json first. Report "Resolved on [date]" instead of re-alerting.
3. PLATFORM-FIRST: Before suggesting custom tools/scripts, check if the platform has a built-in feature (e.g., iCloud Mail Cleanup was in the sidebar the whole time).
4. Also read data/lessons-learned.json for the full lesson database.
- Report to ${OPS_EMAIL} for operational items, ${CEO_EMAIL} only for critical redundancy patterns

DATA FILE: ${DATA_PATH}
`.trim();

// ─── Exported Agent Definition ──────────────────────────────────────
// Used by the orchestrator to include dedup as a subagent.

// NOTE: `tools` is omitted so the subagent inherits all tools from the
// parent (including bureauflow-dedup-tools MCP).
export const dedupAgentDefinition = {
  description:
    "Redundancy detection agent that checks if proposed tasks were already completed in previous sessions. Maintains a persistent task log. ALWAYS consult this agent FIRST before dispatching work to other agents.",
  prompt: SYSTEM_PROMPT,
  model: "sonnet" as const,
  maxTurns: 8,
};

// ─── Run Agent (standalone) ─────────────────────────────────────────

async function main() {
  const userPrompt =
    process.argv.slice(2).join(" ") ||
    "List all completed tasks and summarize what has been done recently.";

  console.log(`\n🔍 BureauFlow Dedup Agent — Redundancy Detector`);
  console.log(`📋 Query: ${userPrompt}\n`);

  const conversation = query({
    prompt: userPrompt,
    options: {
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "bureauflow-dedup-tools": dedupMcp },
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
        `\n✅ Dedup check complete (${message.duration_ms}ms, $${message.total_cost_usd.toFixed(4)})`
      );
    }
  }
}

// Only run main() when this file is invoked as the entrypoint — importing
// it from the orchestrator (for dedupAgentDefinition / dedupMcp) must NOT
// trigger a standalone dedup-agent run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
