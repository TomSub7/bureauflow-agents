/**
 * BureauFlow Proactive Scheduler — Periodic Agent Runner
 *
 * Lightweight scheduler that runs agents proactively on a configurable
 * interval. Tracks last run time in data/scheduler-state.json to avoid
 * re-running agents that already ran within their interval window.
 *
 * Dispatch model: every scheduled tick is routed through the orchestrator
 * (runOrchestrator in src/index.ts) so the prompt is actually handled by
 * a subagent with full tool access. The previous implementation fired a
 * toolless query() directly and every "run" was just plain LLM chatter
 * with no MCP access — that was the "dispatch making bad decisions" bug.
 *
 * Default schedule:
 * - evolve-agent:  every 24h (daily improvement check)
 * - monitor-agent: every 6h  (health check)
 * - lead-agent:    every 4h  (check new signups)
 * - dedup-agent:   every 12h (update task history)
 *
 * Usage: npx tsx src/proactive-scheduler.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runOrchestrator } from "./index.js";

// ─── File Paths ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = resolve(__dirname, "..", "data");
const STATE_PATH = resolve(DATA_DIR, "scheduler-state.json");

// ─── Types ─────────────────────────────────────────────────────────

interface ScheduledAgent {
  name: string;
  intervalMs: number;
  promptFn: () => string;
}

interface AgentRunRecord {
  lastRunAt: string;
  lastRunMs: number;
  lastCostUsd: number;
  lastStatus: "success" | "error";
  lastError?: string;
  totalRuns: number;
}

interface SchedulerState {
  agents: Record<string, AgentRunRecord>;
  schedulerStartedAt: string;
}

// ─── State Persistence ─────────────────────────────────────────────

function loadState(): SchedulerState {
  if (!existsSync(STATE_PATH)) {
    return {
      agents: {},
      schedulerStartedAt: new Date().toISOString(),
    };
  }
  const raw = readFileSync(STATE_PATH, "utf-8");
  return JSON.parse(raw) as SchedulerState;
}

function saveState(state: SchedulerState): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// ─── Agent Runner ──────────────────────────────────────────────────

async function runAgent(
  agent: ScheduledAgent,
  state: SchedulerState
): Promise<void> {
  const now = Date.now();
  const record = state.agents[agent.name];

  // Check if agent ran recently enough to skip
  if (record) {
    const lastRun = new Date(record.lastRunAt).getTime();
    const elapsed = now - lastRun;
    if (elapsed < agent.intervalMs) {
      const nextRunIn = Math.round((agent.intervalMs - elapsed) / 60_000);
      console.log(
        `  [SKIP] ${agent.name} — ran ${Math.round(elapsed / 60_000)}min ago, next run in ${nextRunIn}min`
      );
      return;
    }
  }

  // Wrap the raw prompt so the orchestrator routes to the intended agent.
  // Without this hint the orchestrator would pick whichever subagent best
  // matched the text, which defeats the purpose of a per-agent schedule.
  const rawPrompt = agent.promptFn();
  const prompt = `Dispatch the following task to the ${agent.name} (and only that agent, after the mandatory dedup check). Task: ${rawPrompt}`;
  console.log(`  [RUN]  ${agent.name} — "${rawPrompt.slice(0, 80)}..."`);

  const startMs = Date.now();
  let durationMs = 0;
  const costUsd = 0;
  let status: "success" | "error" = "success";
  let errorMsg: string | undefined;

  try {
    await runOrchestrator(prompt);
    durationMs = Date.now() - startMs;
  } catch (err) {
    status = "error";
    errorMsg = err instanceof Error ? err.message : String(err);
    durationMs = Date.now() - startMs;
    console.error(`  [ERR]  ${agent.name} — ${errorMsg}`);
  }

  // Update state
  const existing = state.agents[agent.name];
  state.agents[agent.name] = {
    lastRunAt: new Date().toISOString(),
    lastRunMs: durationMs,
    lastCostUsd: costUsd,
    lastStatus: status,
    lastError: errorMsg,
    totalRuns: (existing?.totalRuns ?? 0) + 1,
  };
  saveState(state);

  const costStr = costUsd > 0 ? `$${costUsd.toFixed(4)}` : "n/a";
  console.log(
    `  [DONE] ${agent.name} — ${status} in ${durationMs}ms (${costStr})`
  );
}

// ─── Schedule Configuration ────────────────────────────────────────

const HOUR = 60 * 60 * 1000;

const DEFAULT_SCHEDULE: ScheduledAgent[] = [
  {
    name: "evolve-agent",
    intervalMs: 24 * HOUR,
    promptFn: () =>
      "Analyze all agents, check for stale data, and generate a full improvement report.",
  },
  {
    name: "monitor-agent",
    intervalMs: 6 * HOUR,
    promptFn: () =>
      "Run a full infrastructure health check and generate a briefing.",
  },
  {
    name: "lead-agent",
    intervalMs: 4 * HOUR,
    promptFn: () =>
      "Check for new signups in the last 4 hours. Score and qualify any new leads.",
  },
  {
    name: "dedup-agent",
    intervalMs: 12 * HOUR,
    promptFn: () =>
      "List all completed tasks and verify the task history is current.",
  },
];

// ─── Public API ────────────────────────────────────────────────────

/**
 * Schedule an agent to run periodically.
 *
 * @param agentName - Name of the agent (used as key in state tracking)
 * @param intervalMs - Interval in milliseconds between runs
 * @param promptFn - Function returning the prompt to send to the agent
 * @returns The interval handle (call clearInterval to stop)
 *
 * @example
 * ```ts
 * const handle = scheduleAgent("evolve-agent", 24 * 60 * 60 * 1000, () =>
 *   "Analyze all agents and generate improvement report."
 * );
 * // Later: clearInterval(handle);
 * ```
 */
export function scheduleAgent(
  agentName: string,
  intervalMs: number,
  promptFn: () => string
): ReturnType<typeof setInterval> {
  const agent: ScheduledAgent = {
    name: agentName,
    intervalMs,
    promptFn,
  };

  console.log(
    `  Scheduled: ${agentName} every ${Math.round(intervalMs / 60_000)}min`
  );

  // Run immediately on first tick, then on interval
  const state = loadState();
  runAgent(agent, state).catch(console.error);

  return setInterval(() => {
    const freshState = loadState();
    runAgent(agent, freshState).catch(console.error);
  }, intervalMs);
}

// ─── Scheduler Loop ────────────────────────────────────────────────

async function runOnce(): Promise<void> {
  console.log(`\n--- BureauFlow Scheduler — One-shot run ---`);
  console.log(`Agents: ${DEFAULT_SCHEDULE.map((a) => a.name).join(", ")}\n`);

  const state = loadState();

  for (const agent of DEFAULT_SCHEDULE) {
    await runAgent(agent, state);
  }

  console.log(`\n--- Scheduler run complete ---\n`);
}

async function runDaemon(): Promise<void> {
  console.log(`\n🕐 BureauFlow Proactive Scheduler — Daemon Mode`);
  console.log(`Agents: ${DEFAULT_SCHEDULE.length}`);
  console.log(
    DEFAULT_SCHEDULE.map(
      (a) => `  - ${a.name}: every ${Math.round(a.intervalMs / HOUR)}h`
    ).join("\n")
  );
  console.log(`State file: ${STATE_PATH}\n`);

  const handles: ReturnType<typeof setInterval>[] = [];

  for (const agent of DEFAULT_SCHEDULE) {
    const handle = scheduleAgent(
      agent.name,
      agent.intervalMs,
      agent.promptFn
    );
    handles.push(handle);
  }

  // Keep process alive
  process.on("SIGINT", () => {
    console.log("\nShutting down scheduler...");
    for (const h of handles) {
      clearInterval(h);
    }
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\nScheduler terminated.");
    for (const h of handles) {
      clearInterval(h);
    }
    process.exit(0);
  });
}

// ─── CLI Entry Point ───────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isDaemon = args.includes("--daemon") || args.includes("-d");
  const isStatus = args.includes("--status") || args.includes("-s");

  if (isStatus) {
    const state = loadState();
    console.log(`\n📊 BureauFlow Scheduler State`);
    console.log(`Started: ${state.schedulerStartedAt}\n`);

    for (const [name, record] of Object.entries(state.agents)) {
      const elapsed = Date.now() - new Date(record.lastRunAt).getTime();
      const agoMin = Math.round(elapsed / 60_000);
      console.log(`  ${name}:`);
      console.log(`    Last run: ${record.lastRunAt} (${agoMin}min ago)`);
      console.log(`    Status: ${record.lastStatus} (${record.lastRunMs}ms, $${record.lastCostUsd.toFixed(4)})`);
      console.log(`    Total runs: ${record.totalRuns}`);
      if (record.lastError) {
        console.log(`    Last error: ${record.lastError}`);
      }
    }

    const scheduled = DEFAULT_SCHEDULE.filter(
      (a) => !state.agents[a.name]
    );
    if (scheduled.length > 0) {
      console.log(`\n  Never run: ${scheduled.map((a) => a.name).join(", ")}`);
    }
    return;
  }

  if (isDaemon) {
    await runDaemon();
  } else {
    await runOnce();
  }
}

// Only run main() when invoked as the entrypoint.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
