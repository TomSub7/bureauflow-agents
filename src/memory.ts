/**
 * BureauFlow Agent Suite — Persistent Learning Memory
 *
 * Cross-session memory that all agents import. Provides four data stores:
 *
 * 1. **Interaction Log** — Append-only JSONL at data/interactions.jsonl
 *    Tracks every agent invocation with timing, tools, and cost.
 *    Auto-rotates at 10,000 lines (drops oldest entries).
 *
 * 2. **Learning Store** — Key-value store at data/learnings.json
 *    Agents persist insights (e.g., "best_converting_trade" → "Elektriker")
 *    and retrieve them in future sessions.
 *
 * 3. **Performance Trends** — Aggregated daily metrics at data/trends.json
 *    Used by evolve-agent to track improvement over time.
 *
 * 4. **FAQ Gap Tracker** — Missing FAQ entries at data/faq-gaps.json
 *    support-agent records unanswered questions; evolve-agent picks them up.
 *
 * All I/O is synchronous (readFileSync/writeFileSync) since agents run as
 * standalone scripts, not servers.
 *
 * Usage:
 *   import { logInteraction, saveLearning, getLearning } from "./memory.js";
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Paths ─────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = resolve(__dirname, "..", "data");

const INTERACTIONS_PATH = resolve(DATA_DIR, "interactions.jsonl");
const LEARNINGS_PATH = resolve(DATA_DIR, "learnings.json");
const TRENDS_PATH = resolve(DATA_DIR, "trends.json");
const FAQ_GAPS_PATH = resolve(DATA_DIR, "faq-gaps.json");

const MAX_INTERACTION_LINES = 10_000;

// ─── Types ─────────────────────────────────────────────────────────

export interface InteractionEntry {
  timestamp: string;
  agentName: string;
  prompt: string;
  toolsUsed: string[];
  result: string;
  durationMs: number;
  costUsd: number;
}

export interface LearningStore {
  /** Keyed by agentName, then by learning key */
  [agentName: string]: Record<string, unknown>;
}

export interface DailyTrend {
  date: string;
  agentName: string;
  totalCalls: number;
  avgDurationMs: number;
  errorRate: number;
  topTools: string[];
}

export interface TrendsStore {
  days: DailyTrend[];
}

export interface FaqGap {
  id: string;
  question: string;
  context: string;
  recordedAt: string;
  resolved: boolean;
}

export interface FaqGapsStore {
  gaps: FaqGap[];
}

// ─── Init: ensure data directory and files exist ───────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureFile(path: string, defaultContent: string): void {
  ensureDataDir();
  if (!existsSync(path)) {
    writeFileSync(path, defaultContent, "utf-8");
  }
}

// Initialize all data files on module load
ensureFile(INTERACTIONS_PATH, "");
ensureFile(LEARNINGS_PATH, "{}");
ensureFile(TRENDS_PATH, JSON.stringify({ days: [] } satisfies TrendsStore));
ensureFile(
  FAQ_GAPS_PATH,
  JSON.stringify({ gaps: [] } satisfies FaqGapsStore)
);

// ─── 1. Interaction Log ────────────────────────────────────────────

/**
 * Append a single interaction entry to data/interactions.jsonl.
 * Automatically rotates when the file exceeds MAX_INTERACTION_LINES.
 */
export function logInteraction(entry: InteractionEntry): void {
  const line = JSON.stringify({
    ...entry,
    timestamp: entry.timestamp || new Date().toISOString(),
  });

  // True append — no full rewrite on the common path.
  appendFileSync(INTERACTIONS_PATH, line + "\n", "utf-8");

  // Rotate only when the cap is exceeded: read, trim oldest, rewrite once.
  const lines = readFileSync(INTERACTIONS_PATH, "utf-8").trimEnd().split("\n");
  if (lines.length > MAX_INTERACTION_LINES) {
    const trimmed = lines.slice(lines.length - MAX_INTERACTION_LINES);
    writeFileSync(INTERACTIONS_PATH, trimmed.join("\n") + "\n", "utf-8");
  }
}

/**
 * Retrieve the last N interactions for a specific agent.
 * Returns newest-first.
 */
export function getRecentInteractions(
  agentName: string,
  limit: number = 20
): InteractionEntry[] {
  const raw = readFileSync(INTERACTIONS_PATH, "utf-8").trimEnd();
  if (!raw) return [];

  const allLines = raw.split("\n");
  const results: InteractionEntry[] = [];

  // Walk backwards for efficiency (we want the most recent)
  for (let i = allLines.length - 1; i >= 0 && results.length < limit; i--) {
    const line = allLines[i];
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as InteractionEntry;
      if (entry.agentName === agentName) {
        results.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return results;
}

// ─── 2. Learning Store ─────────────────────────────────────────────

function loadLearnings(): LearningStore {
  const raw = readFileSync(LEARNINGS_PATH, "utf-8");
  try {
    return JSON.parse(raw) as LearningStore;
  } catch {
    return {};
  }
}

function persistLearnings(store: LearningStore): void {
  writeFileSync(LEARNINGS_PATH, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Save an insight for an agent. Overwrites if the key already exists.
 *
 * @example
 *   saveLearning("support-agent", "common_questions", ["pricing", "setup", "cancel"]);
 *   saveLearning("lead-agent", "best_converting_trade", "Elektriker");
 */
export function saveLearning(
  agentName: string,
  key: string,
  value: unknown
): void {
  const store = loadLearnings();
  if (!store[agentName]) {
    store[agentName] = {};
  }
  store[agentName][key] = value;
  persistLearnings(store);
}

/**
 * Retrieve a previously saved insight. Returns undefined if not found.
 */
export function getLearning(
  agentName: string,
  key: string
): unknown | undefined {
  const store = loadLearnings();
  return store[agentName]?.[key];
}

/**
 * Retrieve all learnings for an agent. Returns an empty object if none exist.
 */
export function getAllLearnings(
  agentName: string
): Record<string, unknown> {
  const store = loadLearnings();
  return store[agentName] ?? {};
}

// ─── 3. Performance Trends ─────────────────────────────────────────

function loadTrends(): TrendsStore {
  const raw = readFileSync(TRENDS_PATH, "utf-8");
  try {
    return JSON.parse(raw) as TrendsStore;
  } catch {
    return { days: [] };
  }
}

function persistTrends(store: TrendsStore): void {
  writeFileSync(TRENDS_PATH, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Aggregate raw interactions into daily trend summaries.
 * Reads all entries from interactions.jsonl, groups by date + agentName,
 * and writes the results to data/trends.json.
 *
 * Designed to be called once per day (e.g., from a cron or evolve-agent).
 */
export function updateTrends(): void {
  const raw = readFileSync(INTERACTIONS_PATH, "utf-8").trimEnd();
  if (!raw) return;

  const lines = raw.split("\n");

  // Group by "date|agentName"
  const groups = new Map<
    string,
    { durations: number[]; tools: string[]; errors: number; total: number }
  >();

  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as InteractionEntry;
      const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
      const groupKey = `${date}|${entry.agentName}`;

      let group = groups.get(groupKey);
      if (!group) {
        group = { durations: [], tools: [], errors: 0, total: 0 };
        groups.set(groupKey, group);
      }

      group.total++;
      group.durations.push(entry.durationMs);
      group.tools.push(...entry.toolsUsed);

      // Treat result containing "error" (case-insensitive) as an error
      if (entry.result.toLowerCase().includes("error")) {
        group.errors++;
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Build trend entries
  const days: DailyTrend[] = [];

  for (const [groupKey, group] of groups) {
    const [date, agentName] = groupKey.split("|");

    const avgDurationMs =
      group.durations.length > 0
        ? Math.round(
            group.durations.reduce((a, b) => a + b, 0) /
              group.durations.length
          )
        : 0;

    const errorRate =
      group.total > 0
        ? Math.round((group.errors / group.total) * 10000) / 10000
        : 0;

    // Count tool frequencies and pick top 5
    const toolCounts = new Map<string, number>();
    for (const t of group.tools) {
      toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
    }
    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    days.push({
      date,
      agentName,
      totalCalls: group.total,
      avgDurationMs,
      errorRate,
      topTools,
    });
  }

  // Sort by date descending, then agent name
  days.sort((a, b) => {
    const dateCmp = b.date.localeCompare(a.date);
    if (dateCmp !== 0) return dateCmp;
    return a.agentName.localeCompare(b.agentName);
  });

  persistTrends({ days });
}

/**
 * Get trend data for a specific agent, optionally limited to recent N days.
 */
export function getTrends(
  agentName: string,
  lastNDays?: number
): DailyTrend[] {
  const store = loadTrends();
  let filtered = store.days.filter((d) => d.agentName === agentName);

  if (lastNDays !== undefined) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lastNDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    filtered = filtered.filter((d) => d.date >= cutoffStr);
  }

  return filtered;
}

// ─── 4. FAQ Gap Tracker ────────────────────────────────────────────

function loadFaqGaps(): FaqGapsStore {
  const raw = readFileSync(FAQ_GAPS_PATH, "utf-8");
  try {
    return JSON.parse(raw) as FaqGapsStore;
  } catch {
    return { gaps: [] };
  }
}

function persistFaqGaps(store: FaqGapsStore): void {
  writeFileSync(FAQ_GAPS_PATH, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Record a question that the support-agent could not answer from the FAQ.
 * The evolve-agent picks these up and suggests FAQ additions.
 */
export function recordFaqGap(question: string, context: string): void {
  const store = loadFaqGaps();

  // Deduplicate: skip if an unresolved gap with the same question already exists
  const normalized = question.toLowerCase().trim();
  const isDuplicate = store.gaps.some(
    (g) => !g.resolved && g.question.toLowerCase().trim() === normalized
  );
  if (isDuplicate) return;

  const gap: FaqGap = {
    id: `faq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    question,
    context,
    recordedAt: new Date().toISOString(),
    resolved: false,
  };

  store.gaps.push(gap);
  persistFaqGaps(store);
}

/**
 * Get all unresolved FAQ gaps (for the evolve-agent to process).
 */
export function getUnresolvedFaqGaps(): FaqGap[] {
  const store = loadFaqGaps();
  return store.gaps.filter((g) => !g.resolved);
}

/**
 * Mark a FAQ gap as resolved (after the FAQ has been updated).
 */
export function resolveFaqGap(gapId: string): boolean {
  const store = loadFaqGaps();
  const gap = store.gaps.find((g) => g.id === gapId);
  if (!gap) return false;
  gap.resolved = true;
  persistFaqGaps(store);
  return true;
}
