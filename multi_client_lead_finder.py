# ============================================================
# MULTI-CLIENT LEAD FINDER (SaaS-style, shared backend)
# ============================================================
# Runs once PER CLIENT, reading that client's own settings (cities,
# categories, daily cap, email) from a shared client registry —
# instead of one hardcoded configuration for a single business.
#
# All clients share the SAME API keys (yours) — clients never see or
# touch billing/API keys. Each client's data (leads, seen-businesses
# history) is kept in separate, client-specific files so nothing mixes.
#
# USAGE:
#   python multi_client_lead_finder.py <client_id>
#
# Example:
#   python multi_client_lead_finder.py client_001
# ============================================================

import requests
import csv
import os
import re
import json
import sys
import smtplib
from datetime import date
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication

# ─── SHARED API KEYS (yours — same across all clients) ───
API_KEY = os.environ.get("PLACES_API_KEY")
BREVO_HOST = "smtp-relay.brevo.com"
BREVO_PORT = 587
BREVO_USERNAME = os.environ.get("BREVO_USERNAME")
BREVO_PASSWORD = os.environ.get("BREVO_PASSWORD")
FROM_EMAIL = os.environ.get("FROM_EMAIL")

# ─── CLIENT REGISTRY ───
# A single JSON file listing every client and their individual settings.
# This is the ONLY place per-client configuration lives — nothing about
# a specific client is hardcoded anywhere else in this script.
#
# Example structure of clients_registry.json:
# {
#   "client_001": {
#     "name": "Priya's Freelance Leads",
#     "email": "priya@example.com",
#     "cities": ["Jaipur", "Udaipur", "Jodhpur"],
#     "categories": ["salons", "clinics", "gyms"],
#     "daily_lead_cap": 20,
#     "min_reviews": 40,
#     "active": true
#   },
#   "client_002": { ... }
# }
CLIENT_REGISTRY_FILE = "clients_registry.json"


def load_client_registry(filename=CLIENT_REGISTRY_FILE):
    """Loads the full registry of all clients and their settings."""
    if not os.path.exists(filename):
        print(f"ERROR: {filename} not found. Cannot look up client settings.")
        return {}
    with open(filename, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            print(f"ERROR: {filename} is corrupted or empty.")
            return {}


def get_client_settings(client_id, registry):
    """Pulls one specific client's settings out of the full registry.
    Returns None if the client doesn't exist or is marked inactive —
    both cases should stop the run cleanly, not crash."""
    client = registry.get(client_id)
    if not client:
        print(f"ERROR: client_id '{client_id}' not found in registry.")
        return None
    if not client.get("active", True):
        print(f"Client '{client_id}' is marked inactive — skipping run.")
        return None
    return client


# ─── PER-CLIENT FILE PATHS ───
# Every client gets their own separate seen-businesses history and
# output file, so nothing from one client ever appears in another's data.
def get_client_seen_file(client_id):
    return f"client_data/{client_id}/seen_businesses.csv"


def get_client_output_file(client_id):
    return f"client_data/{client_id}/leads.xlsx"


def get_client_daily_usage_file(client_id):
    return f"client_data/{client_id}/daily_usage.json"


def ensure_client_folder_exists(client_id):
    os.makedirs(f"client_data/{client_id}", exist_ok=True)


# ─── DAILY CAP TRACKING (persists ACROSS runs, not just within one run) ───
# Without this, daily_lead_cap only limits a single run — triggering the
# script multiple times in one day would let a client rack up multiples
# of their cap, burning through the shared API key's quota/budget.
def load_daily_usage(client_id):
    """Returns leads already used today for this client (0 if a new day
    or no record yet)."""
    filename = get_client_daily_usage_file(client_id)
    today = str(date.today())
    if not os.path.exists(filename):
        return 0
    with open(filename, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            return 0
    if data.get("date") != today:
        return 0  # new day — usage resets
    return data.get("leads_used", 0)


def save_daily_usage(client_id, leads_used_today):
    ensure_client_folder_exists(client_id)
    filename = get_client_daily_usage_file(client_id)
    with open(filename, "w", encoding="utf-8") as f:
        json.dump({"date": str(date.today()), "leads_used": leads_used_today}, f)


# ─── PRICE LEVEL MAPPING (shared logic, not client-specific) ───
PRICE_LEVEL_MAP = {
    "PRICE_LEVEL_FREE": 0,
    "PRICE_LEVEL_INEXPENSIVE": 1,
    "PRICE_LEVEL_MODERATE": 2,
    "PRICE_LEVEL_EXPENSIVE": 3,
    "PRICE_LEVEL_VERY_EXPENSIVE": 4,
}


def get_price_level(place):
    return PRICE_LEVEL_MAP.get(place.get("priceLevel", "PRICE_LEVEL_UNSPECIFIED"), 2)


# ─── DEDUPLICATION (per-client) ───
def make_lead_key(name, address):
    return f"{name.strip().lower()}|{address.strip().lower()}"


def load_seen_businesses(client_id):
    seen = set()
    filename = get_client_seen_file(client_id)
    if not os.path.exists(filename):
        return seen
    with open(filename, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            seen.add(row["key"])
    return seen


def save_seen_businesses(seen, client_id):
    ensure_client_folder_exists(client_id)
    filename = get_client_seen_file(client_id)
    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["key"])
        for key in sorted(seen):
            writer.writerow([key])


# ─── STEP 1: SEARCH GOOGLE PLACES (uses shared API key, client's query) ───
def search_places(query, api_key):
    url = "https://places.googleapis.com/v1/places:searchText"
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": (
            "places.displayName,places.formattedAddress,"
            "places.rating,places.userRatingCount,places.priceLevel,"
            "places.websiteUri,places.nationalPhoneNumber,"
            "places.types,places.photos,places.regularOpeningHours"
        )
    }
    body = {"textQuery": query}
    response = requests.post(url, headers=headers, json=body)
    if response.status_code != 200:
        print(f"ERROR searching '{query}': {response.text}")
        return []
    return response.json().get("places", [])


# ─── STEP 2: QUALITY FILTER (uses client's own min_reviews setting) ───
def passes_size_filter(place, min_reviews):
    review_count = place.get("userRatingCount", 0)
    photo_count = len(place.get("photos", []))
    price_level = get_price_level(place)

    if review_count < min_reviews:
        return False
    if price_level < 1:
        return False
    if photo_count < 5:
        return False

    has_phone = bool(place.get("nationalPhoneNumber", "").strip())
    has_website = bool(place.get("websiteUri", "").strip())
    if not has_phone and not has_website:
        return False

    return True


# ─── STEP 3: DIGITAL PRESENCE CHECK (shared logic) ───
def check_digital_presence(place):
    website = place.get("websiteUri", None)
    if not website:
        return "No website", "Strong reviews, no way to showcase/book online"

    website_lower = website.lower()
    if "facebook.com" in website_lower or "instagram.com" in website_lower:
        return "Social media only", "Good social presence, missing a proper website"

    return "Has a website", "Has a site — worth checking if it's modern/mobile-friendly"


# ─── STEP 4: RUN THE PIPELINE FOR ONE SPECIFIC CLIENT ───
def find_leads_for_client(client_id, client_settings):
    cities = client_settings.get("cities", [])
    categories = client_settings.get("categories", [])
    daily_cap = client_settings.get("daily_lead_cap", 20)
    min_reviews = client_settings.get("min_reviews", 40)

    if not cities or not categories:
        print(f"ERROR: client '{client_id}' has no cities/categories configured.")
        return []

    # ── Enforce the cap PER DAY, not per run ──
    leads_used_today = load_daily_usage(client_id)
    remaining_cap = daily_cap - leads_used_today
    if remaining_cap <= 0:
        print(f"[{client_id}] Daily cap of {daily_cap} already reached today "
              f"({leads_used_today} used) — skipping run, no API calls made.")
        return []
    print(f"[{client_id}] {leads_used_today}/{daily_cap} leads used today — "
          f"{remaining_cap} remaining for this run.")

    search_queries = [
        f"{category} in {city}" for city in cities for category in categories
    ]

    seen = load_seen_businesses(client_id)
    print(f"[{client_id}] Loaded {len(seen)} previously-seen businesses.")

    all_leads = []
    new_keys = set()

    for query in search_queries:
        if len(all_leads) >= remaining_cap:
            print(f"[{client_id}] Reached remaining daily allowance ({remaining_cap}) — stopping search.")
            break

        print(f"[{client_id}] Searching: {query}")
        places = search_places(query, API_KEY)  # shared key, client's own query

        for place in places:
            if len(all_leads) >= remaining_cap:
                break
            if not passes_size_filter(place, min_reviews):
                continue

            name = place.get("displayName", {}).get("text", "Unknown")
            address = place.get("formattedAddress", "")
            key = make_lead_key(name, address)

            if key in seen or key in new_keys:
                continue

            digital_status, pitch = check_digital_presence(place)

            all_leads.append({
                "Search Query": query,
                "Business Name": name,
                "Address": address,
                "Phone": place.get("nationalPhoneNumber", ""),
                "Rating": place.get("rating", ""),
                "Review Count": place.get("userRatingCount", ""),
                "Digital Status": digital_status,
                "Suggested Pitch": pitch,
                "Website (if any)": place.get("websiteUri", ""),
            })
            new_keys.add(key)

    if new_keys:
        seen.update(new_keys)
        save_seen_businesses(seen, client_id)
        print(f"[{client_id}] Added {len(new_keys)} new businesses "
              f"(total tracked: {len(seen)}).")

    # Update today's usage total so the NEXT run today (if any) respects
    # what's already been spent, regardless of how many leads passed filters.
    save_daily_usage(client_id, leads_used_today + len(all_leads))

    return all_leads


# ─── STEP 5: SAVE TO CLIENT'S OWN WELL-FORMATTED SPREADSHEET ───
def save_client_leads(leads, client_id):
    if not leads:
        print(f"[{client_id}] No leads found this run.")
        return None

    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter

    # Sort: "No website" leads first (clearest pitch), then by review
    # count descending, so the strongest leads surface at the top.
    def sort_key(lead):
        status = lead.get("Digital Status", "")
        status_priority = 0 if status == "No website" else 1
        try:
            reviews = int(lead.get("Review Count") or 0)
        except (ValueError, TypeError):
            reviews = 0
        return (status_priority, -reviews)

    leads_sorted = sorted(leads, key=sort_key)

    ensure_client_folder_exists(client_id)
    filename = get_client_output_file(client_id)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Leads"

    headers = list(leads_sorted[0].keys())
    ws.append(headers)

    # Header styling — bold, dark blue background, white text, wrapped
    header_font = Font(name="Arial", bold=True, color="FFFFFF", size=11)
    header_fill = PatternFill(start_color="2F5496", end_color="2F5496", fill_type="solid")
    for col_num, _ in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_num)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 28

    # Color coding — green for "No website" (clearest pitch), yellow for
    # "Social media only" (softer pitch angle needed)
    status_col_index = headers.index("Digital Status") + 1 if "Digital Status" in headers else None
    GREEN = PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
    YELLOW = PatternFill(start_color="FFEB9C", end_color="FFEB9C", fill_type="solid")

    body_font = Font(name="Arial", size=10)
    for row_num, lead in enumerate(leads_sorted, start=2):
        for col_num, header in enumerate(headers, start=1):
            cell = ws.cell(row=row_num, column=col_num, value=lead.get(header, ""))
            cell.font = body_font
            cell.alignment = Alignment(vertical="top", wrap_text=True)

        if status_col_index:
            status_value = lead.get("Digital Status", "")
            status_cell = ws.cell(row=row_num, column=status_col_index)
            if status_value == "No website":
                status_cell.fill = GREEN
            elif status_value == "Social media only":
                status_cell.fill = YELLOW

    # Column widths — wide for text-heavy fields, narrow for short ones,
    # so nothing looks cramped or runs off-screen on a phone.
    WIDE_COLUMNS = {"Address", "Suggested Pitch", "Website (if any)"}
    NARROW_COLUMNS = {"Rating", "Review Count", "Phone"}
    for col_num, header in enumerate(headers, start=1):
        letter = get_column_letter(col_num)
        if header in WIDE_COLUMNS:
            ws.column_dimensions[letter].width = 32
        elif header in NARROW_COLUMNS:
            ws.column_dimensions[letter].width = 14
        else:
            ws.column_dimensions[letter].width = 20

    ws.freeze_panes = "A2"  # header row stays visible while scrolling
    ws.auto_filter.ref = ws.dimensions  # dropdown filters on every column

    wb.save(filename)
    print(f"[{client_id}] Saved {len(leads_sorted)} leads to {filename}")
    return filename


# ─── STEP 6: EMAIL RESULTS TO THE CLIENT ───
def send_client_email(filename, lead_count, client_settings, client_id):
    client_email = client_settings.get("email")
    client_name = client_settings.get("name", client_id)

    if not client_email:
        print(f"[{client_id}] No email configured — skipping send.")
        return

    if not filename:
        subject = f"{client_name} — No new leads today"
        body = "Today's search found no new businesses matching your filters."
    else:
        subject = f"{client_name} — {lead_count} new leads found!"
        body = f"Your lead search found {lead_count} qualified leads today. See attached."

    msg = MIMEMultipart()
    msg["From"] = FROM_EMAIL
    msg["To"] = client_email
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))

    if filename:
        with open(filename, "rb") as f:
            part = MIMEApplication(f.read(), Name=os.path.basename(filename))
        part["Content-Disposition"] = f'attachment; filename="{os.path.basename(filename)}"'
        msg.attach(part)

    with smtplib.SMTP(BREVO_HOST, BREVO_PORT) as server:
        server.starttls()
        server.login(BREVO_USERNAME, BREVO_PASSWORD)
        server.send_message(msg)

    print(f"[{client_id}] Email sent to {client_email}.")


# ─── RUN FOR ONE CLIENT (passed as a command-line argument) ───
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python multi_client_lead_finder.py <client_id>")
        sys.exit(1)

    client_id = sys.argv[1]
    registry = load_client_registry()
    client_settings = get_client_settings(client_id, registry)

    if client_settings is None:
        sys.exit(1)  # error already printed above

    print(f"Running lead finder for client: {client_settings.get('name', client_id)}")
    leads = find_leads_for_client(client_id, client_settings)
    filename = save_client_leads(leads, client_id)
    send_client_email(filename, len(leads), client_settings, client_id)
