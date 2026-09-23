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
BRAVE_API_KEY = os.environ.get("BRAVE_API_KEY")
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


# ─── STEP 3b: WEBSITE WEAK-POINT SCAN (only for leads with a real site) ───
# Factual, signature-based checks only — this looks for known script tags
# and HTML elements, never guesses at design/copy quality. One honest
# limitation: a plain HTML fetch doesn't run JavaScript, so a tool that
# injects itself after page load (rather than being in the raw HTML)
# could be missed. Good enough as a signal, not a guarantee of absence.
EMAIL_AUTOMATION_SIGNATURES = {
    "Mailchimp": ["list-manage.com", "chimpstatic.com"],
    "Klaviyo": ["klaviyo.com", "klaviyo.min.js"],
    "Brevo": ["sibforms.com", "sendinblue.com"],
    "HubSpot": ["hs-forms", "hsforms.net", "hubspot.com"],
    "ConvertKit": ["convertkit.com"],
    "ActiveCampaign": ["activecampaign.com", "activehosted.com"],
}

CHAT_SIGNATURES = {
    "Intercom": ["intercom.io", "intercomcdn.com"],
    "Drift": ["drift.com"],
    "Tawk.to": ["tawk.to"],
    "Crisp": ["crisp.chat"],
}

ANALYTICS_SIGNATURES = {
    "Google Analytics": ["google-analytics.com", "googletagmanager.com", "gtag("],
    "Facebook Pixel": ["connect.facebook.net", "fbevents.js"],
}

BOOKING_SIGNATURES = {
    "Calendly": ["calendly.com"],
}

REVIEW_SIGNATURES = {
    "Trustpilot": ["trustpilot.com"],
    "Judge.me": ["judge.me"],
}

# Platform fingerprints — checked on the same fetch as everything else
# above, so detecting these costs nothing extra. Order matters: checked
# roughly most-common-first so the first match wins for platforms that
# might share generic signals.
ECOMMERCE_PLATFORM_SIGNATURES = {
    "Shopify": ["cdn.shopify.com", "myshopify.com", "shopify.theme"],
    "WooCommerce": ["woocommerce", "wp-content/plugins/woocommerce"],
    "BigCommerce": ["cdn11.bigcommerce.com", "bigcommerce.com"],
    "Magento": ["mage-cache-storage", "/skin/frontend/", "magento"],
    "Wix Stores": ["wixstores", "wix-code"],
    "Squarespace Commerce": ["squarespace-commerce"],
}


def _detect_platform(html_lower):
    for platform_name, needles in ECOMMERCE_PLATFORM_SIGNATURES.items():
        if any(needle in html_lower for needle in needles):
            return platform_name
    return None


def _detect_any(html_lower, signature_map):
    return any(
        needle in html_lower
        for needles in signature_map.values()
        for needle in needles
    )


def analyze_website(url):
    """
    Fetches a business's homepage once and checks for a handful of
    factual, objective gaps — never a design/copy opinion. If
    PAGESPEED_API_KEY is set, also pulls a real Google PageSpeed mobile
    score (25,000 free requests/day per Google Cloud project — no
    billing card required at this scale).
    """
    weak_points = []
    pagespeed_score = None
    ecommerce_platform = None

    try:
        resp = requests.get(
            url,
            timeout=8,
            headers={"User-Agent": "Mozilla/5.0 (compatible; LeadFinderBot/1.0)"},
        )
        html = resp.text
        html_lower = html.lower()

        ecommerce_platform = _detect_platform(html_lower)

        if not _detect_any(html_lower, EMAIL_AUTOMATION_SIGNATURES):
            weak_points.append("No email automation tool detected")
        if not _detect_any(html_lower, CHAT_SIGNATURES):
            weak_points.append("No live chat widget detected")
        if not _detect_any(html_lower, ANALYTICS_SIGNATURES):
            weak_points.append("No analytics/tracking detected")
        if not _detect_any(html_lower, BOOKING_SIGNATURES):
            weak_points.append("No online booking tool detected")
        if not _detect_any(html_lower, REVIEW_SIGNATURES):
            weak_points.append("No review-widget tool detected")

        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, "html.parser")

            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            if not title:
                weak_points.append("Missing page title (hurts SEO)")

            meta_desc = soup.find("meta", attrs={"name": "description"})
            if not meta_desc or not (meta_desc.get("content") or "").strip():
                weak_points.append("Missing meta description (hurts SEO)")

            if not soup.find("h1"):
                weak_points.append("No H1 heading found (hurts SEO)")

            images = soup.find_all("img")
            if images:
                with_alt = sum(1 for img in images if (img.get("alt") or "").strip())
                if with_alt / len(images) < 0.5:
                    weak_points.append("Most images missing alt text (SEO/accessibility)")
        except Exception as parse_err:
            print(f"  (HTML parsing skipped: {parse_err})")

    except Exception as e:
        weak_points.append("Could not load site to analyze")
        print(f"  Website analysis failed for {url}: {e}")

    pagespeed_key = os.environ.get("PAGESPEED_API_KEY")
    if pagespeed_key:
        try:
            psi_resp = requests.get(
                "https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
                params={"url": url, "key": pagespeed_key, "strategy": "mobile"},
                timeout=20,
            )
            if psi_resp.status_code == 200:
                score = (
                    psi_resp.json()
                    .get("lighthouseResult", {})
                    .get("categories", {})
                    .get("performance", {})
                    .get("score")
                )
                if score is not None:
                    pagespeed_score = round(score * 100)
                    if pagespeed_score < 50:
                        weak_points.append(f"Slow mobile site — PageSpeed score {pagespeed_score}/100")
            else:
                print(f"  PageSpeed check failed ({psi_resp.status_code}) for {url}")
        except Exception as e:
            print(f"  PageSpeed check errored for {url}: {e}")

    return {
        "weak_points": weak_points,
        "pagespeed_score": pagespeed_score,
        "ecommerce_platform": ecommerce_platform,
    }


# ─── STEP 3c: PURE ONLINE-ONLY STORE DISCOVERY (Brave Search) ───
# Google Places structurally cannot see online-only businesses — no
# physical address, nothing to index. This uses Brave's Search API
# (free tier: ~1,000 queries/month, no card required) to find candidate
# store URLs via search, then runs them through the SAME analyze_website()
# scanner already used above to confirm the platform and pull weak-points
# data — no separate/duplicate detection logic needed.
def search_online_stores_via_brave(niche, max_results=10):
    if not BRAVE_API_KEY:
        return []

    queries = [
        f'site:myshopify.com "{niche}"',
        f'"{niche}" "powered by woocommerce"',
    ]

    urls = []
    seen_domains = set()

    for q in queries:
        try:
            resp = requests.get(
                "https://api.search.brave.com/res/v1/web/search",
                headers={
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip",
                    "X-Subscription-Token": BRAVE_API_KEY,
                },
                params={"q": q, "count": max_results},
                timeout=10,
            )
            if resp.status_code != 200:
                print(f"  Brave search failed ({resp.status_code}) for query: {q}")
                continue

            results = resp.json().get("web", {}).get("results", [])
            for r in results:
                url = r.get("url", "")
                if not url:
                    continue
                domain = url.split("/")[2] if "//" in url else url
                if domain in seen_domains:
                    continue
                seen_domains.add(domain)
                urls.append(url)
        except Exception as e:
            print(f"  Brave search errored for query '{q}': {e}")

    return urls[:max_results]


STOPWORDS = {"and", "the", "for", "with", "a", "an", "of", "in", "on", "to", "store", "shop", "shops", "stores"}

JUNK_SUBDOMAIN_PATTERNS = ["test", "staging", "-dev", "dev.", "demo", "sandbox", "checkout-", "admin."]

SHOPIFY_PLACEHOLDER_SIGNATURES = [
    "opening soon", "this shop is currently unavailable", "enter using password",
    "this store is unavailable", "coming soon", "shopify.com/on-boarding",
]


def _niche_keywords(niche, max_keywords=2):
    words = [w.strip(",.").lower() for w in niche.split() if w.strip(",.").lower() not in STOPWORDS and len(w) > 2]
    words.sort(key=len, reverse=True)  # longer words tend to be more distinctive
    return words[:max_keywords] or [niche.strip().lower()]


def search_shopify_via_crtsh(niche, max_candidates=30):
    """
    Free, no-key fallback for online-only store discovery — queries the
    public Certificate Transparency log database directly. Unlike Brave,
    this has NO native niche-awareness — it only matches keywords against
    the domain name itself, which is why find_online_only_leads() below
    adds an extra content-relevance check for anything found this way.

    crt.sh is known to be slow/overloaded at times, so this retries once
    on failure rather than giving up immediately.
    """
    keywords = _niche_keywords(niche)
    candidates = set()

    for kw in keywords:
        if len(candidates) >= max_candidates:
            break

        url = f"https://crt.sh/?q=%25{kw}%25.myshopify.com&output=json"
        for attempt in range(2):
            try:
                resp = requests.get(
                    url, timeout=15,
                    headers={"User-Agent": "Mozilla/5.0 (compatible; LeadFinderBot/1.0)"},
                )
                if resp.status_code == 200 and resp.text.strip():
                    records = resp.json()
                    for rec in records:
                        for name in rec.get("name_value", "").split("\n"):
                            name = name.strip().lower().lstrip("*.")
                            if not name.endswith(".myshopify.com"):
                                continue
                            if any(junk in name for junk in JUNK_SUBDOMAIN_PATTERNS):
                                continue
                            candidates.add(name)
                    break  # got a usable response, no need to retry this keyword
            except Exception as e:
                print(f"  crt.sh query failed (attempt {attempt + 1}) for '{kw}': {e}")

    return [f"https://{d}" for d in list(candidates)[:max_candidates]]


def _guess_business_name(html, url):
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        if soup.title and soup.title.string:
            # Titles are often "Brand Name – Tagline" or "Brand | Shop" —
            # take the first segment as the best guess at the actual name.
            raw = soup.title.string.strip()
            for sep in ["–", "-", "|", "—"]:
                if sep in raw:
                    raw = raw.split(sep)[0].strip()
                    break
            if raw:
                return raw
    except Exception:
        pass
    # Fall back to the domain itself if the title didn't give anything usable
    try:
        return url.split("//")[1].split("/")[0].replace("www.", "")
    except Exception:
        return url


def _extract_email(html):
    match = re.search(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", html)
    return match.group(0) if match else ""


def find_online_only_leads(client_id, niches, remaining_cap, seen, new_keys):
    """
    Separate discovery pass for clients who specifically want online-only
    stores (require_ecommerce_platform=True) — Places can't find these at
    all, so this is the only path that surfaces them. Reuses the same
    dedup (seen/new_keys) and remaining_cap accounting as the main loop.

    Uses Brave Search if BRAVE_API_KEY is set (precise, actually niche-
    aware). Otherwise falls back to crt.sh (free, no key, no card) — since
    that path can't search by niche natively, extra filters below compensate:
    junk-subdomain exclusion, placeholder/inactive-page detection, and a
    real content-relevance check before anything counts as a lead.
    """
    leads = []
    using_brave = bool(BRAVE_API_KEY)
    backend_name = "Brave Search" if using_brave else "crt.sh (free fallback)"

    for niche in niches:
        if len(leads) >= remaining_cap:
            break

        print(f"[{client_id}] Searching online-only stores via {backend_name} for: {niche}")
        candidate_urls = (
            search_online_stores_via_brave(niche) if using_brave
            else search_shopify_via_crtsh(niche)
        )

        for url in candidate_urls:
            if len(leads) >= remaining_cap:
                break

            key = make_lead_key(url, "online")
            if key in seen or key in new_keys:
                continue

            try:
                resp = requests.get(
                    url, timeout=8,
                    headers={"User-Agent": "Mozilla/5.0 (compatible; LeadFinderBot/1.0)"},
                )
                html = resp.text
                html_lower = html.lower()
            except Exception as e:
                print(f"  Could not fetch {url}: {e}")
                continue

            # Filter: skip placeholder/inactive stores — a real domain that
            # isn't actually a live business worth pitching.
            if any(sig in html_lower for sig in SHOPIFY_PLACEHOLDER_SIGNATURES):
                continue

            # Filter: crt.sh matched on the DOMAIN NAME only, not real
            # content — confirm the niche genuinely appears on the page
            # before trusting it. Brave already did real niche search, so
            # this extra check is skipped for that path (redundant there).
            if not using_brave:
                niche_words = _niche_keywords(niche, max_keywords=3)
                if not any(w in html_lower for w in niche_words):
                    continue

            # Filter: confirm the platform for real via the same scanner
            # used everywhere else, rather than trusting the discovery
            # method's guess (myshopify.com domain, Brave's search match).
            analysis = analyze_website(url)
            platform = analysis.get("ecommerce_platform")
            if not platform:
                continue

            name = _guess_business_name(html, url)
            email = _extract_email(html)
            weak_points_str = "; ".join(analysis["weak_points"]) if analysis["weak_points"] else "No obvious gaps detected"
            pagespeed_score = analysis["pagespeed_score"] if analysis["pagespeed_score"] is not None else ""

            leads.append({
                "Search Query": f"{niche} (online-only)",
                "Business Name": name,
                "Address": "Online only",
                "Phone": email,
                "Rating": "",
                "Review Count": "",
                "Digital Status": "Has a website",
                "Suggested Pitch": f"Runs a {platform} store — {weak_points_str.split(';')[0] if weak_points_str else 'no obvious gaps detected'}",
                "Website (if any)": url,
                "E-commerce Platform": platform,
                "Weak Points": weak_points_str,
                "PageSpeed Score (mobile)": pagespeed_score,
            })
            new_keys.add(key)

    return leads


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

            # ── Filter by the client's website preference (set at signup
            # or changed later in client-config.html). require_ecommerce
            # implies require_website — you can't have an online store
            # without a real website, so checking "online store only"
            # automatically restricts to "Has a website" leads too. ──
            require_website = client_settings.get("require_website", False)
            require_ecommerce = client_settings.get("require_ecommerce_platform", False)
            effective_require_website = require_website or require_ecommerce
            no_website_statuses = ("No website", "Social media only")
            if effective_require_website and digital_status != "Has a website":
                continue
            if not effective_require_website and digital_status not in no_website_statuses:
                continue

            website_url = place.get("websiteUri", "")
            weak_points_str = ""
            pagespeed_score = ""
            ecommerce_platform = None
            if digital_status == "Has a website" and website_url:
                analysis = analyze_website(website_url)
                weak_points_str = "; ".join(analysis["weak_points"]) if analysis["weak_points"] else "No obvious gaps detected"
                pagespeed_score = analysis["pagespeed_score"] if analysis["pagespeed_score"] is not None else ""
                ecommerce_platform = analysis.get("ecommerce_platform")

            # A client who specifically wants online-store businesses
            # skips this lead entirely if no known platform was detected
            # on the fetched page — same "fail open, don't guess" spirit
            # as the rest of this scanner.
            if require_ecommerce and not ecommerce_platform:
                continue

            all_leads.append({
                "Search Query": query,
                "Business Name": name,
                "Address": address,
                "Phone": place.get("nationalPhoneNumber", ""),
                "Rating": place.get("rating", ""),
                "Review Count": place.get("userRatingCount", ""),
                "Digital Status": digital_status,
                "Suggested Pitch": pitch,
                "Website (if any)": website_url,
                "E-commerce Platform": ecommerce_platform or "",
                "Weak Points": weak_points_str,
                "PageSpeed Score (mobile)": pagespeed_score,
            })
            new_keys.add(key)

    if new_keys:
        seen.update(new_keys)
        save_seen_businesses(seen, client_id)
        print(f"[{client_id}] Added {len(new_keys)} new businesses "
              f"(total tracked: {len(seen)}).")

    # ── Online-only store discovery (Brave Search) ──
    # Only runs for clients who specifically want online-store businesses,
    # and only for whatever daily allowance the Places search didn't use.
    if client_settings.get("require_ecommerce_platform", False):
        remaining_after_places = remaining_cap - len(all_leads)
        if remaining_after_places > 0:
            online_leads = find_online_only_leads(
                client_id, categories, remaining_after_places, seen, new_keys
            )
            if online_leads:
                all_leads.extend(online_leads)
                seen.update(new_keys)
                save_seen_businesses(seen, client_id)
                print(f"[{client_id}] Added {len(online_leads)} online-only store leads.")

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
