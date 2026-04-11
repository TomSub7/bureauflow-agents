#!/usr/bin/env python3
"""
iCloud IMAP Bulk Email Cleanup
Connects to iCloud IMAP and bulk-deletes spam emails by sender.

Usage:
  python icloud-bulk-cleanup.py                  # Delete all known spam senders
  python icloud-bulk-cleanup.py --dry-run        # Count only, no deletion
  python icloud-bulk-cleanup.py --sender "noreply@medium.com"  # Target one sender
  python icloud-bulk-cleanup.py --scan           # Find top volume senders
  python icloud-bulk-cleanup.py --scan --top 30  # Show top 30 senders
"""

import argparse
import email
import imaplib
import os
import sys
import time
from collections import Counter
from email.header import decode_header
from typing import Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

IMAP_HOST = "imap.mail.me.com"
IMAP_PORT = 993
MAILBOX = "INBOX"

# Confirmed spam / newsletter senders to bulk-delete.
# Add new entries as you discover them via --scan.
SPAM_SENDERS: list[str] = [
    # --- Already confirmed (previously deleted, kept for future runs) ---
    "noreply@medium.com",
    "notification@facebookmail.com",

    # --- Confirmed pending deletion ---
    "no-reply@producthunt.com",
    "digest@quora.com",
    "noreply@quora.com",
    "notify@twitter.com",
    "info@x.com",
    "info@mail.udemy.com",

    # --- Common newsletter / marketing senders ---
    "noreply@notify.twitter.com",
    "noreply@linkedin.com",
    "messages-noreply@linkedin.com",
    "news@linkedin.com",
    "invitations@linkedin.com",
    "jobs-noreply@linkedin.com",
    "notifications-noreply@linkedin.com",
    "noreply@e.medium.com",
    "hello@mail.producthunt.com",
    "noreply@reddit.com",
    "noreply@email.reddit.com",
    "email@e.groupon.com",
    "noreply@email.aliexpress.com",
    "deals@email.aliexpress.com",
    "noreply@wish.com",
    "newsletter@mail.wish.com",
    "no-reply@marketing.shopify.com",
    "noreply@email.canva.com",
    "noreply@mail.instagram.com",
    "noreply@facebookmail.com",
    "register@facebookmail.com",
    "security@facebookmail.com",
    "noreply@info.flipboard.com",
    "no-reply@snoosecretgifts.com",
    "offers@email.temu.com",
    "noreply@email.temu.com",
    "no-reply@news.grammarly.com",
    "info@email.glassdoor.com",
    "noreply@glassdoor.com",
    "noreply@info.codecademy.com",
    "no-reply@duolingo.com",
    "hello@email.duolingo.com",
    "noreply@notify.bugsnag.com",
    "noreply@spotify.com",
    "no-reply@spotify.com",
    "noreply@mail.pinterest.com",
    "noreply@email.coursera.org",
    "news@email.udemy.com",
    "noreply@yelp.com",
    "no-reply@yelp.com",
    "info@meetup.com",
    "noreply@meetup.com",
    "noreply@mail.stumbleupon.com",
    "no-reply@quora.com",
    "digest-noreply@quora.com",
    "noreply@e.fiverr.com",
    "no-reply@e.trustpilot.com",
    "noreply@email.microsoft.com",
    "noreply@dropbox.com",
    "no-reply@dropboxmail.com",
    "hello@tiktok.com",
    "noreply@tiktok.com",

    # --- Discovered by spam scanner (2026-04-11) ---
    "newsletters-noreply@linkedin.com",    # 529 emails — LinkedIn newsletters
    "asmallworld@newsletter.asw.com",      # 22 emails
    "newsletter@m.batmaid.com",            # 14 emails
    "newsletters@skift.com",               # 13 emails
    "mailrobot@xing.com",                  # 12 emails — dead platform
    "mailrobot@internations.org",          # 10 emails
]

# Protected domains -- emails from these senders are NEVER deleted.
PROTECTED_DOMAINS: list[str] = [
    # BureauFlow infrastructure
    "bureauflow.de",
    "bureauflow.io",
    "stripe.com",
    "vercel.com",
    "neon.tech",
    "resend.com",
    "github.com",
    "vapi.ai",
    "anthropic.com",
    "google.com",
    "apple.com",
    # OUREA / Closers / Partners
    "ourea.lu",
    "closers.app",
    "porkbun.com",
    "cloudflare.com",
    "lexware.de",
    "millo.gmbh",
    "bubic.de",
    "sentinelegal.ch",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def connect() -> imaplib.IMAP4_SSL:
    """Connect and authenticate to iCloud IMAP."""
    icloud_email = os.environ.get("ICLOUD_EMAIL")
    icloud_password = os.environ.get("ICLOUD_APP_PASSWORD")

    if not icloud_email or not icloud_password:
        print("ERROR: Set ICLOUD_EMAIL and ICLOUD_APP_PASSWORD environment variables.")
        print("       Generate an app-specific password at https://appleid.apple.com")
        sys.exit(1)

    print(f"Connecting to {IMAP_HOST}:{IMAP_PORT} as {icloud_email} ...")
    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    conn.login(icloud_email, icloud_password)
    print("Authenticated.\n")
    return conn


def is_protected(sender: str) -> bool:
    """Check if a sender address belongs to a protected domain."""
    sender_lower = sender.lower()
    return any(sender_lower.endswith(f"@{d}") or sender_lower.endswith(f".{d}")
               for d in PROTECTED_DOMAINS)


def search_sender(conn: imaplib.IMAP4_SSL, sender: str) -> list[bytes]:
    """Search INBOX for all messages FROM a given sender. Returns list of UIDs."""
    # Use UID SEARCH so results are stable across operations
    status, data = conn.uid("SEARCH", None, f'(FROM "{sender}")')
    if status != "OK":
        print(f"  SEARCH failed for {sender}: {status}")
        return []
    uid_list = data[0].split() if data[0] else []
    return uid_list


def bulk_delete(conn: imaplib.IMAP4_SSL, uids: list[bytes]) -> int:
    """
    Mark UIDs as Deleted and expunge. Uses comma-separated UID set for speed.
    Returns the count of deleted messages.
    """
    if not uids:
        return 0
    # Build comma-separated UID set: b"1,2,3,4"
    uid_set = b",".join(uids)
    # Flag all as Deleted in one command
    status, _ = conn.uid("STORE", uid_set, "+FLAGS", r"(\Deleted)")
    if status != "OK":
        print(f"  STORE failed: {status}")
        return 0
    # Expunge to permanently remove
    conn.expunge()
    return len(uids)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def run_cleanup(conn: imaplib.IMAP4_SSL, senders: list[str], dry_run: bool) -> None:
    """Delete emails from all listed senders."""
    conn.select(MAILBOX)

    total_found = 0
    total_deleted = 0
    results: list[tuple[str, int]] = []

    mode = "DRY RUN" if dry_run else "DELETE"
    print(f"=== iCloud Bulk Cleanup ({mode}) ===\n")

    for sender in senders:
        # Safety check: never touch protected senders
        if is_protected(sender):
            print(f"  SKIP (protected): {sender}")
            continue

        uids = search_sender(conn, sender)
        count = len(uids)
        total_found += count

        if count == 0:
            print(f"  {sender:50s}  0 emails")
            continue

        if dry_run:
            print(f"  {sender:50s}  {count} emails (would delete)")
        else:
            deleted = bulk_delete(conn, uids)
            total_deleted += deleted
            print(f"  {sender:50s}  {deleted} emails DELETED")

        results.append((sender, count))

    # Summary
    print(f"\n{'=' * 60}")
    print(f"Senders scanned:  {len(senders)}")
    print(f"Total emails found: {total_found}")
    if dry_run:
        print(f"Total to delete:  {total_found}")
        print("(no emails were deleted -- dry run)")
    else:
        print(f"Total deleted:    {total_deleted}")
    print(f"{'=' * 60}")


def run_scan(conn: imaplib.IMAP4_SSL, top_n: int, sample_size: int) -> None:
    """
    Scan recent messages to find high-volume senders.
    Helps discover new spam senders to add to the list.
    """
    conn.select(MAILBOX, readonly=True)

    print(f"=== Sender Volume Scan (last {sample_size} messages) ===\n")

    # Get total message count
    status, data = conn.search(None, "ALL")
    if status != "OK":
        print("SEARCH ALL failed.")
        return
    all_ids = data[0].split()
    total = len(all_ids)
    print(f"Mailbox total: {total} messages\n")

    # Take the last N message sequence numbers
    recent_ids = all_ids[-sample_size:] if len(all_ids) >= sample_size else all_ids
    id_set = b",".join(recent_ids)

    # Fetch only the FROM header for speed
    print(f"Fetching headers for {len(recent_ids)} messages ...")
    status, fetch_data = conn.fetch(id_set, "(BODY.PEEK[HEADER.FIELDS (FROM)])")
    if status != "OK":
        print(f"FETCH failed: {status}")
        return

    sender_counter: Counter[str] = Counter()
    for item in fetch_data:
        if isinstance(item, tuple) and len(item) >= 2:
            header_bytes = item[1]
            try:
                msg = email.message_from_bytes(header_bytes)
                from_header = msg.get("From", "")
                # Extract just the email address
                if "<" in from_header and ">" in from_header:
                    addr = from_header.split("<")[1].split(">")[0].strip().lower()
                else:
                    addr = from_header.strip().lower()
                if addr:
                    sender_counter[addr] += 1
            except Exception:
                continue

    # Display top senders
    print(f"\nTop {top_n} senders by volume:\n")
    print(f"  {'Count':>6}  {'Status':10}  Sender")
    print(f"  {'-----':>6}  {'------':10}  {'------'}")
    for addr, count in sender_counter.most_common(top_n):
        if is_protected(addr):
            tag = "PROTECTED"
        elif addr in SPAM_SENDERS:
            tag = "LISTED"
        else:
            tag = "NEW"
        print(f"  {count:>6}  {tag:10}  {addr}")

    print(f"\n  Unique senders in sample: {len(sender_counter)}")
    print(f"  Messages sampled: {len(recent_ids)} / {total}")

    # Suggest new additions
    new_high_volume = [
        (addr, count) for addr, count in sender_counter.most_common(100)
        if not is_protected(addr) and addr not in SPAM_SENDERS and count >= 3
    ]
    if new_high_volume:
        print(f"\n  Suggested additions (NEW, >= 3 emails):")
        for addr, count in new_high_volume[:20]:
            print(f"    \"{addr}\",  # {count} emails")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="iCloud IMAP bulk email cleanup by sender",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Count emails per sender without deleting",
    )
    parser.add_argument(
        "--sender",
        type=str,
        help="Target a specific sender email address",
    )
    parser.add_argument(
        "--scan",
        action="store_true",
        help="Scan recent messages and show top senders by volume",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=20,
        help="Number of top senders to show in scan (default: 20)",
    )
    parser.add_argument(
        "--sample",
        type=int,
        default=1000,
        help="Number of recent messages to sample in scan (default: 1000)",
    )
    args = parser.parse_args()

    # Load .env file if python-dotenv is available
    try:
        from dotenv import load_dotenv
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
        if os.path.exists(env_path):
            load_dotenv(env_path)
            print(f"Loaded .env from {env_path}")
    except ImportError:
        pass  # dotenv not installed, rely on shell env vars

    start_time = time.time()
    conn: Optional[imaplib.IMAP4_SSL] = None

    try:
        conn = connect()

        if args.scan:
            run_scan(conn, top_n=args.top, sample_size=args.sample)
        else:
            if args.sender:
                # Single sender mode
                if is_protected(args.sender.lower()):
                    print(f"ERROR: {args.sender} is a protected sender. Aborting.")
                    sys.exit(1)
                senders = [args.sender.lower()]
            else:
                senders = SPAM_SENDERS
            run_cleanup(conn, senders, dry_run=args.dry_run)

    except imaplib.IMAP4.error as e:
        print(f"\nIMAP ERROR: {e}")
        print("Check your ICLOUD_EMAIL and ICLOUD_APP_PASSWORD.")
        print("Generate an app-specific password at https://appleid.apple.com")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n\nInterrupted by user.")
    finally:
        elapsed = time.time() - start_time
        print(f"\nTime elapsed: {elapsed:.1f}s")
        if conn:
            try:
                conn.close()
            except Exception:
                pass
            conn.logout()
            print("Disconnected.")


if __name__ == "__main__":
    main()
