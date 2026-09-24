"""
send_renewal_reminders.py
============================================================
Runs daily via .github/workflows/renewal-reminders.yml.

For every ACTIVE client, finds their most recent "entry" event in
signups_log.json (the moment they were last activated/renewed) and
sends a reminder email if they're 3 days out from the 30-day mark.

Uses a window (27-29 days) rather than an exact "day 27" check, so a
missed or delayed workflow run doesn't cause a client to silently skip
their reminder entirely. reminder_log.json tracks which activation
cycle a client has already been reminded for, so re-running this
script (or it running daily across that 3-day window) never sends
the same reminder twice for the same cycle.

NOTE: there's no automated billing yet (Dodo Payments application was
rejected; Razorpay pending KYC), so the reminder email currently tells
the client to pay manually via UPI QR code and message you to confirm
— update REMINDER_BODY_TEMPLATE below once real recurring billing
exists, at which point this can likely be retired in favor of the
payment provider's own renewal/dunning emails.
============================================================
"""

import json
import os
import smtplib
from datetime import datetime, timezone
from email.mime.text import MIMEText

from multi_client_lead_finder import (
    BREVO_HOST, BREVO_PORT, BREVO_USERNAME, BREVO_PASSWORD, FROM_EMAIL,
    load_client_registry,
)

REGISTRY_PATH = "clients_registry.json"
LOG_PATH = "signups_log.json"
REMINDER_LOG_PATH = "reminder_log.json"

REMINDER_WINDOW_MIN_DAYS = 27
REMINDER_WINDOW_MAX_DAYS = 29

REMINDER_BODY_TEMPLATE = """Hi {name},

Your monthly lead search subscription is ending in about 3 days.

To keep your daily leads coming without interruption, please renew by
scanning the payment QR code sent separately (or reply to this email
if you need it again) and send confirmation once paid — we'll
reactivate your pipeline right away.

Thanks for being a client!
"""


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def most_recent_entry_timestamp(client_id, log):
    entries = [
        e for e in log
        if e.get("client_id") == client_id and e.get("event") == "entry"
    ]
    if not entries:
        return None
    entries.sort(key=lambda e: e["timestamp"])
    return entries[-1]["timestamp"]


def send_reminder_email(client_email, client_name):
    body = REMINDER_BODY_TEMPLATE.format(name=client_name or "there")
    msg = MIMEText(body, "plain")
    msg["From"] = FROM_EMAIL
    msg["To"] = client_email
    msg["Subject"] = "Your subscription renews in 3 days"

    with smtplib.SMTP(BREVO_HOST, BREVO_PORT) as server:
        server.starttls()
        server.login(BREVO_USERNAME, BREVO_PASSWORD)
        server.send_message(msg)


def main():
    registry = load_client_registry(REGISTRY_PATH)
    log = load_json(LOG_PATH, [])
    reminder_log = load_json(REMINDER_LOG_PATH, {})

    now = datetime.now(timezone.utc)
    sent_count = 0

    for client_id, client in registry.items():
        if not client.get("active", False):
            continue

        entry_ts = most_recent_entry_timestamp(client_id, log)
        if not entry_ts:
            continue

        entry_dt = datetime.fromisoformat(entry_ts)
        days_since = (now - entry_dt).days

        if not (REMINDER_WINDOW_MIN_DAYS <= days_since <= REMINDER_WINDOW_MAX_DAYS):
            continue

        if reminder_log.get(client_id) == entry_ts:
            print(f"[{client_id}] Already reminded for this cycle — skipping.")
            continue

        email = client.get("email")
        if not email:
            print(f"[{client_id}] No email on file — skipping.")
            continue

        try:
            send_reminder_email(email, client.get("name"))
            reminder_log[client_id] = entry_ts
            sent_count += 1
            print(f"[{client_id}] Renewal reminder sent to {email} ({days_since} days in).")
        except Exception as e:
            print(f"[{client_id}] Failed to send reminder: {e}")

    save_json(REMINDER_LOG_PATH, reminder_log)
    print(f"\nDone. {sent_count} reminder(s) sent.")


if __name__ == "__main__":
    main()
