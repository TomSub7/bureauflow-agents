# HANDOVER — resuming locally

Context for continuing this work in a **local** Claude Code session (on your
Mac), where — unlike the remote container — Claude can actually see the files
you point it at. Last updated: 2026-06-06.

## How to resume

```bash
git fetch origin
git checkout claude/code-mistakes-remediation-4UJAq
npm install
npx tsc --noEmit   # should be clean
```

Everything is already pushed; nothing is lost if the remote session ends.

## State of the work (PR #1, draft)

**Done and pushed:**
- **Remediation** of real code defects — see `REMEDIATION.md` (10 fixed, a few
  documented). Headline: scaffolding that was never wired in (hooks, memory),
  and a scheduler that didn't actually run the agents.
- **MCP servers** in `.mcp.json`: `perplexity`, `firecrawl`, `glif`
  (network-only). The browser servers were intentionally removed (see below).
- **Jarvis** (`src/jarvis.ts`, `npm run jarvis`): unified orchestrator wiring
  every agent's tools together.
- **Security scope-down** — see `ACCESS.md`.

**Paused (awaiting your go):**
- The "both" seam: a model-selection abstraction so cheap, high-volume tasks
  (`classify_email`, lead pre-scoring) could use a local model behind a flag,
  defaulting to Sonnet. Researched (Open Jarvis is a legitimate Stanford
  local-first framework; the TikTok was affiliate marketing; no real CVE).
  Not built yet.

## Security first — read `ACCESS.md`

Before continuing feature work, the open safety item is **on your Mac, not in
this repo**: the autonomous folders in your iCloud
(`_remote-control-inbox`/`-outbox`, `_phase_autonomous`, `_helper-inbox`,
`_LOOP-FIRE-QUEUE`) were created by **some other system**, not this project.
`ACCESS.md` has the audit checklist. First local task should be:

1. `launchctl list`; inspect `~/Library/LaunchAgents`, `/Library/LaunchAgents`,
   `/Library/LaunchDaemons`; `crontab -l`; System Settings → Login Items.
2. System Settings → Privacy & Security → Full Disk Access / Automation —
   revoke anything unrecognized.
3. Revoke Google/Stripe OAuth, rotate API keys if anything unvetted held them.
4. Identify what writes the `_remote-control-*` folders, then stop its launch
   agent before removing it.

## How to run the local session safely

- Start `claude` **inside a specific directory** (this repo, or a scratch dir
  for the Mac audit) — **not** your home or iCloud root.
- Keep it **interactive**: approve actions as they come. Do **not** enable
  auto-accept/autonomous modes while investigating a possible rogue agent.
- It's ephemeral and in-the-loop by default — that's the safety property the
  remote autonomous setup lacked.

## Open question to answer locally

What created the `_remote-control-*` / `_phase_autonomous` folders (another
Claude? an OpenClaw/Open-Jarvis-style agent? a cron script)? Answering that is
the prerequisite to safely shutting it down.
