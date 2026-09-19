"""
run_demo_search.py
============================================================
One-off script for generating a sample lead sheet for a PROSPECT —
someone who hasn't signed up or paid yet. This deliberately bypasses
clients_registry.json and the `active` flag entirely: it calls the
same core search/export functions your real pipeline uses, but with
a throwaway demo ID, so nothing here touches production client data
or requires payment.

TWO WAYS TO RUN THIS:

1. From GitHub Actions (recommended — no local setup needed):
   Go to Actions → "Run Demo Search" → Run workflow → fill in city,
   categories, etc. → download the result from the finished run's
   Artifacts section.

2. Locally: edit the DEMO_ID / DEMO_SETTINGS fallback values below,
   then run: python run_demo_search.py
   Find the output at client_data/<DEMO_ID>/leads.xlsx

This creates its own small "seen businesses" file under
client_data/<DEMO_ID>/ — same as any real client would — so running
the same demo_label again won't repeat the same businesses. Use a
new label for a fully fresh run.
============================================================
"""

import os

from multi_client_lead_finder import find_leads_for_client, save_client_leads

# ── Local fallback values — only used if the matching env var isn't set
# (i.e. when running this manually rather than via GitHub Actions) ──
DEMO_ID = os.environ.get("DEMO_ID", "demo_local_test")
DEMO_CITY = os.environ.get("DEMO_CITY", "Dehradun")
DEMO_CATEGORIES = os.environ.get("DEMO_CATEGORIES", "dental clinics")
DEMO_LEAD_CAP = os.environ.get("DEMO_LEAD_CAP", "15")
DEMO_MIN_REVIEWS = os.environ.get("DEMO_MIN_REVIEWS", "40")
DEMO_REQUIRE_WEBSITE = os.environ.get("DEMO_REQUIRE_WEBSITE", "false").lower() == "true"

DEMO_SETTINGS = {
    "cities": [c.strip() for c in DEMO_CITY.split(",") if c.strip()],
    "categories": [c.strip() for c in DEMO_CATEGORIES.split(",") if c.strip()],
    "daily_lead_cap": int(DEMO_LEAD_CAP),
    "min_reviews": int(DEMO_MIN_REVIEWS),
    "require_website": DEMO_REQUIRE_WEBSITE,
}
# ──────────────────────────────────────────

if __name__ == "__main__":
    print(f"Running demo search for '{DEMO_ID}'...")
    print(f"Cities: {DEMO_SETTINGS['cities']} | Categories: {DEMO_SETTINGS['categories']}")
    leads = find_leads_for_client(DEMO_ID, DEMO_SETTINGS)

    if not leads:
        print("No leads found — try loosening min_reviews or adding more cities/categories.")
    else:
        filename = save_client_leads(leads, DEMO_ID)
        print(f"\nDone. {len(leads)} sample leads saved to: {filename}")
        print("Review the sheet, then send it to your prospect yourself.")
