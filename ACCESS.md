# ACCESS — what this project can and cannot reach

A plain-language security map of the `bureauflow-agents` project, written so you
always have it on record. Last reviewed: 2026-06-06.

## The short version

- This Claude Code session runs in a **remote, isolated cloud container** that
  was given a **fresh clone of this repo only**. It is **not connected to your
  Mac**, and that separation is intentional — see
  https://code.claude.com/docs/en/claude-code-on-the-web.
- It **cannot** see your iCloud Drive, Desktop, Documents, Finance, or any
  local file. It cannot see your other repositories.
- The "disconnect" between your computer and this session is **by design, not a
  fault.** Nothing here reaches back to your machine.

## What this project CAN reach

| Surface | Scope |
|---|---|
| **Files** | Only the cloned repo inside the container (`/home/user/bureauflow-agents`). |
| **GitHub** | Scoped to **`tomsub7/bureauflow-agents`** only. No other repos. |
| **Network credentials** (only if present in the container env — separate from your Mac) | `DATABASE_URL` (Neon), `RESEND_API_KEY`, `VAPI_API_KEY`, `ANTHROPIC_API_KEY` |
| **MCP — in-process tools** | The agent suite's own tools (FAQ, classify, score, dedup, cron/health). Pure in-memory logic + the repo's `data/` JSON files. |
| **MCP — external, network-only, key-gated** | Perplexity, Firecrawl, glif (research/media APIs); Gmail IMAP, Google Calendar, Stripe, Composio — **each runs only if its key is set**, and all are remote API calls. |

**One honest exception:** `dedup-agent.ts` and `evolve-agent.ts` read
`process.env.HOME` to look for `~/.claude/.../memory/MEMORY.md`. In this
container that is the container's home. **If you run these scripts on your Mac,
that single line reads one file in your real home directory** (read-only). It is
the only place the code reaches outside the repo.

## What this project CANNOT reach

- Your Mac filesystem / iCloud Drive (`_personal`, `07_Finance`, `_recovery`,
  `CV`, `08_Legal`, etc.) — **invisible to this session.**
- The autonomous folders in your iCloud — `_remote-control-inbox`,
  `_remote-control-outbox`, `_phase_autonomous`, `_helper-inbox`,
  `_LOOP-FIRE-QUEUE`, `_TIKTOK_RESEARCH`. These were created by **some other
  system on your machine**, not by this project. This project has no link to
  them and cannot read or write them.
- Any GitHub repo other than `tomsub7/bureauflow-agents`.

## Safety changes made on this branch

- **Removed the browser-control MCP servers** (`playwright`, `chrome-devtools`)
  from `.mcp.json` — they can drive your real logged-in browser locally. Re-add
  only if you deliberately want that.
- **Email cleanup now defaults to dry-run** (`--live` required to delete).
- **No secrets are committed** — `.env` is gitignored; `.mcp.json` uses
  `${VAR}` env expansion only. Verified.
- The proactive scheduler and orchestrator were fixed so they only do what
  they say (see `REMEDIATION.md`).

## What only YOU can do — auditing your Mac

This session cannot inspect your machine. If you want to account for what has
autonomous/remote access locally, do this on your Mac:

1. **Find what's writing the `_remote-control-*` / `_phase_autonomous` folders.**
   That system — not this repo — is what has broad local access. Check:
   - Background agents: `launchctl list` and the folders
     `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons`.
   - Cron: `crontab -l`.
   - **Login Items:** System Settings → General → Login Items & Extensions.
2. **Review which apps have broad permissions:** System Settings → Privacy &
   Security → Full Disk Access, Accessibility, Automation, Files & Folders.
   Revoke anything you don't recognize.
3. **Revoke cloud access tokens** an autonomous agent may hold:
   - Google: https://myaccount.google.com/permissions (remove app access /
     revoke OAuth) and app passwords at https://myaccount.google.com/apppasswords.
   - Stripe: roll keys at https://dashboard.stripe.com/apikeys.
   - Anthropic / Perplexity / Firecrawl / glif: rotate the API keys.
4. **If you ever installed an "install-once" agent** (e.g. via `curl | bash`):
   inspect `~/.openjarvis`, `~/.openclaw`, or similar; an autonomous agent there
   typically holds shell + filesystem + OAuth. Stop its background process and
   remove its launch agent before deleting it.
5. **Rotate any secret** you suspect an unvetted tool saw — assume plaintext
   storage.

If you tell me what created those `_remote-control-*` folders, I can help you
reason through its access and a safe shutdown — but I cannot see or touch it
from here.
