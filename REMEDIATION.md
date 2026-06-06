# Code Mistakes — Remediation Plan

Audit of the BureauFlow Agent Suite for real defects introduced during prior
AI-assisted ("Claude") development sessions. Each entry has a **root cause**,
**impact**, **severity**, and a **remediation plan**. Items marked ✅ **Fixed**
are addressed in this branch; items marked 📋 **Planned** are documented here
for a follow-up because they require a design/behaviour decision and cannot be
verified at runtime in this environment.

> Note: the SDK surface the code targets (`@anthropic-ai/claude-agent-sdk`
> options like `effort`, `permissionMode: "bypassPermissions"`,
> `allowDangerouslySkipPermissions`, `includeHookEvents`, `persistSession`,
> the `PostToolUseFailure` hook, structured `outputFormat`) was verified
> against the installed `0.2.101` type definitions — these are **real** APIs,
> not hallucinations. `npx tsc --noEmit` passes both before and after.

---

## Theme A — "Looks built, never wired in" (dead scaffolding)

This is the dominant class of mistake: substantial, well-documented modules
that no agent ever actually calls. They give the *impression* of a working
self-improvement / observability layer while doing nothing at runtime.

### M1 — The entire hooks/metrics system was never attached to any agent ✅ Fixed
- **Root cause:** `config.ts` exposes `createAgentOptions()`, which is the *only*
  place that bundles `hooks: createAgentHooks(...)` into a query. A grep shows
  `createAgentOptions` is referenced **only in its own definition and
  docstring** — every agent hand-rolls its `options` object inline and omits
  `hooks`. So `hooks.ts` (PreToolUse logging, PostToolUse metrics,
  `PostToolUseFailure` capture, Stop summary) never runs.
- **Impact:** Zero tool-call logging, zero metrics, no run summaries — despite
  ~300 lines of hook code. `getMetrics()` (used by `evolve-agent`) is therefore
  always empty (see M3).
- **Severity:** High (silent no-op of a core subsystem).
- **Remediation:** Route every standalone agent's `query()` through
  `createAgentOptions({ agentName, effort, maxTurns })` so hooks are actually
  attached. Done for support, email, email-live, lead, ops, monitor, dedup.

### M2 — The persistent-memory module is never imported 📋 Planned
- **Root cause:** `memory.ts` (interaction log, learnings KV, trend
  aggregation, FAQ-gap tracker) is fully implemented but **not imported by a
  single agent**. `data/interactions.jsonl` is 0 bytes and `data/learnings.json`
  is `{}` as a direct result.
- **Impact:** No cross-session memory exists; the "self-improving" claim is not
  realized. `updateTrends()` has no input, so `data/trends.json` stays empty.
- **Severity:** High (advertised capability is inert).
- **Remediation plan:**
  1. In each agent's `result` handler, call
     `logInteraction({ agentName, prompt, toolsUsed, result, durationMs, costUsd })`.
  2. Have `support-agent` call `recordFaqGap()` when `lookup_faq` returns no
     match, and `evolve-agent` consume `getUnresolvedFaqGaps()`.
  3. Schedule `updateTrends()` from the scheduler (or `evolve-agent`) so
     `trends.json` is populated.
  Deferred because it changes every agent's run loop and needs the metric
  source (M3) settled first.

### M3 — `evolve-agent` reads metrics that are always empty 📋 Planned
- **Root cause:** `analyzeAgentMetrics()` calls `getMetrics(agentName)` from
  `hooks.ts`, but that store is **process-local** and only populated while an
  agent runs *in the same process*. `evolve-agent` is a separate process, so
  `getMetrics` always returns `undefined` → every agent is reported with
  `hasMetrics: false` and a neutral `healthScore: 50` on every run.
- **Impact:** The performance-analysis half of the evolution report is
  meaningless.
- **Severity:** Medium–High.
- **Remediation plan:** Persist metrics to disk at the `Stop` hook (e.g.
  `data/metrics/<agent>-<ts>.json`) and have `evolve-agent` aggregate the
  persisted files instead of the in-memory store. Pairs naturally with M2.

### M4 — External MCP connectors are wired into nothing 📋 Planned
- **Root cause:** `mcp-connectors.ts` builds Gmail/Calendar/Stripe/Composio
  servers and a `getAvailableMcpServers()` aggregator, but only `createGmailMcp`
  (in `email-agent-live`) is ever used. `lead-agent`'s prompt claims it can
  "check if a lead is already a paying customer" via Stripe, and `support-agent`
  implies calendar access — neither agent is passed those servers.
- **Impact:** Prompts promise live-data capabilities the agents cannot perform;
  they will hallucinate instead of querying.
- **Severity:** Medium.
- **Remediation plan:** Pass `getAvailableMcpServers()` (or the specific
  connector) into `lead-agent`/`support-agent` `mcpServers`, and soften the
  prompts to say "if Stripe/Calendar is configured." Deferred — needs live
  credentials to validate.

### M5 — Orchestrator subagents have no tools 📋 Planned
- **Root cause:** In `index.ts` the `support/email/lead` `AgentDefinition`s have
  `tools: []`, and the orchestrator `query()` only passes the orchestrator +
  dedup MCP servers. The per-agent MCP servers (`bureauflow-support-tools`,
  etc.) are defined in their own files but never imported/passed here.
- **Impact:** In suite mode those subagents can only emit text — `lookup_faq`,
  `classify_email`, `score_lead` are unavailable.
- **Severity:** Medium.
- **Remediation plan:** Export each agent's MCP server and pass them all in the
  orchestrator's `mcpServers`, or refactor agents to share a single tool
  registry. Deferred — touches the orchestrator's subagent contract.

---

## Theme B — Concrete correctness bugs

### M6 — Scheduler never actually runs the agents ✅ Fixed
- **Root cause:** `proactive-scheduler.ts#runAgent` called
  `query({ prompt, options })` with **no `systemPrompt`, no `mcpServers`, no
  agent definition, and `tools: []`** — i.e. it sent a generic sentence to a
  bare model. The "evolve/monitor/lead/dedup agents" were never invoked.
- **Impact:** The headline "agents run themselves on schedule" feature was
  theatre — it produced model chatter with none of the agents' tools or
  prompts, while logging cost/duration as if real work happened.
- **Severity:** High.
- **Remediation:** Spawn the real agent entrypoints
  (`npx tsx src/<agent>.ts`) as child processes so the actual tools/prompts run.

### M7 — Scheduler state writes race and clobber each other ✅ Fixed
- **Root cause:** In daemon mode each `scheduleAgent` loads its own copy of the
  whole state file and `saveState()` rewrites the entire object. Concurrent
  immediate-runs at startup each persist a stale snapshot → lost updates
  (last writer wins).
- **Impact:** `totalRuns` undercounts; some agents' records silently disappear.
- **Severity:** Medium.
- **Remediation:** Reload state immediately before writing and merge only the
  current agent's record.

### M8 — `support-agent` FAQ matcher uses a nonsense substring scan ✅ Fixed
- **Root cause:** `lookupFaq` filtered FAQs with
  `key.split("").some((_, i, arr) => q.includes(arr.slice(i-2, i+3).join("")))`
  — it splits each *key* into characters and tests whether the question
  contains any 5-char sliding window of the key. This produces erratic
  false positives/negatives and is unmaintainable.
- **Impact:** Wrong or missing FAQ answers; the agent's primary tool is
  unreliable. German questions ("Was kostet…", "Wie kündige ich…") rarely
  contain the English keys.
- **Severity:** Medium.
- **Remediation:** Replace with explicit keyword/synonym matching (incl. German
  synonyms) plus a graceful "no match → list topics" fallback.

### M9 — `memory.ts` "append-only" log rewrites the whole file every call ✅ Fixed
- **Root cause:** `logInteraction` reads the entire file, splits, pushes, and
  `writeFileSync`s the whole thing on **every** append, despite the doc calling
  it "append-only JSONL."
- **Impact:** O(n) write per entry and a window where a crash mid-write can
  truncate the whole log instead of losing one line.
- **Severity:** Low–Medium.
- **Remediation:** Use `appendFileSync` for the write; only read+rewrite when
  the line cap is exceeded (rotation).

### M10 — Gmail SMTP is configured with `secure=true` on port 587 ✅ Fixed
- **Root cause:** `createGmailMcp` sets `SMTP_PORT: "587"` with
  `SMTP_SECURE: "true"`. Port 587 uses STARTTLS (secure starts `false` then
  upgrades); implicit TLS is port 465. `secure=true` on 587 typically fails the
  TLS handshake.
- **Impact:** Outbound mail via the Gmail MCP would fail to connect.
- **Severity:** Medium.
- **Remediation:** Set `SMTP_SECURE: "false"` for STARTTLS on 587 (documented
  inline; switch to 465 if implicit TLS is preferred).

### M11 — `data/lessons-learned.json` count is wrong ✅ Fixed
- **Root cause:** `totalLessons: 6` while the `lessons` array contains 7 entries.
- **Impact:** Any consumer trusting the count under-reports.
- **Severity:** Low.
- **Remediation:** Correct to `7`.

---

## Theme C — Safety

### M12 — Email cleanup deletes by default, gated only by a prompt sentence ✅ Fixed
- **Root cause:** Both `email-agent.ts` and `email-agent-live.ts` default to
  **LIVE** deletion unless `--dry-run` is passed. The "only delete at
  confidence ≥ 0.9" rule lives **only in the system prompt** — there is no
  code-level guard, and `classify_email`'s heuristic `delete` path can return
  0.85 (3 spam signals), so the floor depends entirely on the model obeying
  prose. For a tool with real `delete_message` access to the CEO's inbox, a
  destructive default is dangerous.
- **Impact:** A misclassification or prompt drift can permanently delete real
  email with no second gate.
- **Severity:** High (irreversible action).
- **Remediation (this branch):** Invert the default to **dry-run**; require an
  explicit `--live` flag to enable deletions. `--dry-run` still accepted.
- **Remediation (planned):** Add a hard, code-level confidence floor and a
  protected-sender re-check at the deletion call site rather than trusting the
  prompt.

---

## Theme D — Maintainability (planned)

### M13 — Cron inventory is duplicated 📋 Planned
- **Root cause:** `monitor-agent.ts` hard-codes its own 27-entry `VERCEL_CRONS`
  list that duplicates `automation-map.ts#CRON_JOBS`. The two will drift.
- **Severity:** Low.
- **Remediation plan:** Import the single source of truth from
  `automation-map.ts` and map to the monitor's shape.

### M14 — `SAFE_TOOLS` auto-approve never matched MCP tool names ✅ Fixed
- **Root cause:** `hooks.ts` checks `SAFE_TOOLS.has(tool_name)` with bare names
  (`"lookup_faq"`), but in-process MCP tools are surfaced to hooks as
  `mcp__<server>__<tool>` (e.g. `mcp__bureauflow-support-tools__lookup_faq`),
  so the set never matched. (Latent until M1, which actually wires hooks.)
- **Severity:** Low (latent).
- **Remediation:** Match against both the full name and the suffix after the
  last `__`.
</content>
</invoke>
