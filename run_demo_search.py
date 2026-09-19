"""
run_demo_search.py
============================================================
One-off script for generating a sample lead sheet for a PROSPECT —
someone who hasn't signed up or paid yet. This deliberately bypasses
clients_registry.json and the `active` flag entirely: it calls the
same core search/export functions your real pipeline uses, but with
a throwaway demo ID you make up on the spot, so nothing here touches
production client data or requires payment.

USAGE:
  1. Fill in DEMO_ID and DEMO_SETTINGS below for this specific prospect.
  2. Run: python run_demo_search.py
  3. Find the output file at client_data/<DEMO_ID>/leads.xlsx
  4. Send that file to the prospect yourself — this script does NOT
     email anyone automatically, on purpose, so you can review the
     sheet first.

This creates its own small "seen businesses" file under
client_data/<DEMO_ID>/ — same as any real client would — so if you
run this again later for a follow-up demo, it won't repeat the same
businesses. Delete that folder if you want a fully fresh run.
============================================================
"""

from multi_client_lead_finder import find_leads_for_client, save_client_leads

# ── EDIT THESE TWO THINGS FOR EACH DEMO ──
DEMO_ID = "demo_discordclient1"  # any short unique label, no spaces

DEMO_SETTINGS = {
    "cities": ["Dehradun"],                # cities this prospect cares about
    "categories": ["dental clinics"],      # categories his AI-suggested list produced
    "daily_lead_cap": 15,                  # how many leads to include in the sample
    "min_reviews": 40,
}
# ──────────────────────────────────────────

if __name__ == "__main__":
    print(f"Running demo search for '{DEMO_ID}'...")
    leads = find_leads_for_client(DEMO_ID, DEMO_SETTINGS)

    if not leads:
        print("No leads found — try loosening min_reviews or adding more cities/categories.")
    else:
        filename = save_client_leads(leads, DEMO_ID)
        print(f"\nDone. {len(leads)} sample leads saved to: {filename}")
        print("Review the sheet, then send it to your prospect yourself.")
