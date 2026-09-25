# LocalSignal / AR Designs — Lead Generation Pipeline
**Project Summary — last updated September 2026**

## What this is

A subscription lead-generation service. Freelancers and small agencies (web developers, marketing/automation consultants) sign up, describe what they sell, and pick target cities and business categories. Every day, an automated pipeline searches for matching local businesses, filters them by quality signals, and emails a spreadsheet of leads to the client — no manual work required after signup.

Run by Anmol Rattan (AR Designs), solo operator.

---

## Architecture at a glance

```
┌─────────────────┐     ┌──────────────────────┐     ┌────────────────────┐
│  Signup / Config │────▶│  Netlify Functions    │────▶│  GitHub repo        │
│  (static HTML)   │     │  (serverless backend) │     │  (acts as database) │
└─────────────────┘     └──────────────────────┘     └──────────┬─────────┘
                                                                  │
                                                                  ▼
                                                    ┌──────────────────────────┐
                                                    │ GitHub Actions (cron)     │
                                                    │ multi_client_lead_finder  │
                                                    │ .py — daily lead search   │
                                                    └──────────┬───────────────┘
                                                                │
                                                                ▼
                                                    Google Places API, Brave
                                                    Search / crt.sh, PageSpeed,
                                                    Brevo (email delivery)
```

**Key design choice:** there is no traditional database. `clients_registry.json` (current client state) and `signups_log.json` (append-only entry/exit audit trail) live directly in the GitHub repo and are read/written via GitHub's Contents API. This was a deliberate cost/simplicity tradeoff — works well at current scale (a handful of clients), would need revisiting if this grows to dozens+.

---

## The three frontend pages (static HTML, deployed to Netlify)

- **`localsignal-signup-1.html`** — the public signup form. Collects name, email, target cities/categories, daily lead cap, min review threshold, and two toggle preferences (see "Client preferences" below). Has an AI-powered "suggest categories" helper (describe your service in plain English, get suggested business categories to target).
- **`client-config.html`** — self-service settings page. A client looks themselves up by Client ID **and** email (both required — prevents anyone from editing another client's data just by guessing an ID), can view/edit their settings, and toggle their pipeline on/off (which logs an exit event if they turn it off).
- **`AR_Designs_Client_Pipeline.html`** — Anmol's admin dashboard. Shows active client count, weekly signups, total removed, a 30-day activity chart, city breakdown, and a live activity feed. Reads aggregated (never raw/PII) stats from `get-dashboard-data.js`.

## Netlify serverless functions (`netlify/functions/`)

| Function | Purpose |
|---|---|
| `submit-signup.js` | Handles new signups. Writes a new client to the registry with `active: false` — nothing runs until payment is confirmed. |
| `get-client.js` | Looks up a client's settings, requires matching client_id **and** email. |
| `save-client-config.js` | Saves changes to an existing client's settings. Also detects active→inactive/inactive→active transitions and logs the corresponding exit/entry event. |
| `suggest-categories.js` | Calls Groq's LLM API to suggest business categories from a free-text service description. Rate-limited per IP (10/hour) using a GitHub-stored counter, since this endpoint has no client_id to check against and is callable before signup completes. |
| `get-dashboard-data.js` | Aggregates registry + log data into dashboard stats. Never returns raw client emails to the browser. |
| `create-payment-link.js`, `dodo-webhook.js` | Built for Dodo Payments integration. **Currently unused** — see "Payment status" below. |

## The core engine: `multi_client_lead_finder.py`

Runs daily via GitHub Actions (`multi-client-workflow.yml`). For each active client:

1. Loads their settings (cities, categories, daily cap, min reviews, preferences)
2. For each city × category combination, searches Google Places API
3. Filters results by review count and basic quality signals
4. Checks each business's "digital status": No website / Social media only / Has a website
5. **If the client wants only "no website" businesses** (default) or **only "has a website" businesses** (toggle) — filters accordingly
6. For businesses with a real website, runs `analyze_website()`:
   - Fetches the homepage HTML (one request, no JS execution)
   - Checks for known signature strings: email automation tools, live chat, analytics, booking, review widgets
   - Basic on-page SEO checks: title tag, meta description, H1, image alt text
   - Detects e-commerce platform (Shopify/WooCommerce/Magento/BigCommerce/Wix/Squarespace) via the same fetch
   - Optionally calls Google PageSpeed Insights for a real mobile performance score (needs `PAGESPEED_API_KEY`)
7. **If the client specifically wants online-store businesses** (`require_ecommerce_platform`), an additional discovery pass runs for **pure online-only stores** that Google Places structurally cannot see (no physical address). Uses Brave Search API if `BRAVE_API_KEY` is set (precise, niche-aware); otherwise falls back to querying crt.sh's public Certificate Transparency logs directly (free, no key, no card — but not niche-aware at the source, so extra content-relevance filtering compensates)
8. Enforces a **persistent daily lead cap** — tracked in a small JSON file per client, so triggering the pipeline multiple times in one day can't accidentally send someone 40 leads instead of 20
9. Dedupes against a running list of previously-sent businesses per client (never repeats the same lead twice)
10. Exports results to `leads.xlsx` and emails it via Brevo SMTP

## GitHub Actions workflows (`.github/workflows/`)

| Workflow | Trigger | Purpose |
|---|---|---|
| `multi-client-workflow.yml` | Daily cron (~9 AM IST) | The real production run — processes every active client |
| `demo-search.yml` | Manual (`workflow_dispatch`) | Generates a one-off sample lead sheet for a prospect, completely bypassing the registry/payment system — used to send prospective clients a demo before they sign up |
| `suspend-client.yml` | Manual | Admin tool: suspend or reactivate a specific client by ID, with a dropdown. Logs the transition as an exit/entry event. Commits with `[skip netlify]` so it doesn't waste a deploy on a pure data change |
| `renewal-reminders.yml` | Daily cron | Emails clients 3 days before their 30-day mark (see "Payment status" — this is a manual-process stopgap right now) |

## Client preferences (set at signup, editable later)

- **`require_website`** (default `false`) — `false` shows businesses with no website or social-only presence (for web developers pitching new sites); `true` shows businesses that already have a website (for marketers/automation consultants)
- **`require_ecommerce_platform`** (default `false`) — when `true`, only shows businesses running a detected e-commerce platform (implies `require_website: true`); triggers the online-only-store discovery pass described above

---

## Payment status — currently manual, this is important

**Two payment gateway integrations were attempted and both failed:**
- **Razorpay** — blocked by video KYC requiring a physical PAN card (Anmol only has a virtual copy)
- **Dodo Payments** — application outright rejected: "we currently do not support [lead generation] services" — a category-level rejection, not fixable by resubmitting

**Current process, until one of these is resolved:**
1. Client signs up → lands in registry as `active: false`
2. Signup success screen shows a **static PhonePe/UPI QR code image** (`payment-qr.jpg`) with instructions to pay and email confirmation
3. Anmol manually confirms payment was received
4. Anmol manually runs the "Suspend or Reactivate Client" GitHub Action, selecting "reactivate" for that client's ID
5. `renewal-reminders.yml` emails the client 3 days before their 30-day mark, telling them to pay again the same manual way

**Planned real fix (not yet done):** reissue a physical PAN card to unblock Razorpay (India-first, UPI has zero fees, best long-term fit) — this is in progress as of this summary. A secondary option being considered: Lemon Squeezy or Paddle (Merchant-of-Record platforms, generally accept solo SaaS products with document-only KYC, no video call) — apply with "software subscription" framing, not "lead generation service" wording, given the category-rejection pattern seen with Dodo.

**Pricing:** landed on $20-25/month (international-friendly USD pricing chosen over ₹1999 since clients now include non-Indian freelancers).

---

## Known issues / things a new collaborator should check

1. **Multiple Netlify sites exist**, created over the course of this build due to hitting free-tier deploy credit limits. At least one older site may still be running **stale code from before the payment gate existed** — this already caused one client ("Soul") to get auto-activated without paying. **This needs a full audit**: list every site in the Netlify account, confirm which one is canonical, delete or redeploy the rest.
2. **Env vars are scattered** across two places — Netlify (functions: Groq, GitHub token, Dodo (unused)) and GitHub Actions secrets (Python script: Places API, Brevo, PageSpeed, Brave (not yet set)). Keep this distinction in mind when debugging — a missing var in the wrong place is a common failure mode here.
3. **Apify integration was attempted and abandoned** for e-commerce discovery — the specific actor tried (`muhammadafzal/shopify-store-scraper`) had a broken/untested "discover by category" mode and very low real-world usage. Don't re-attempt with the same actor; if revisiting Apify, vet usage counts and reviews first.
4. **crt.sh discovery is a genuine fallback, not equivalent to Brave** — it has no niche-awareness at the source, relies on domain-name coincidence plus a content-relevance double-check. Expect noisier, lower-volume results from this path until a card is available for Brave's API.
5. **The `.github/workflows/` folder is easy to accidentally break** — a workflow file must live at that exact path (with the leading dot) or GitHub silently ignores it entirely. This has happened twice during this build, including once from a direct manual edit on GitHub's web UI that deleted the whole folder and re-added a workflow at the wrong path. Avoid editing workflow files directly in GitHub's UI — make changes through a proper commit process instead.
6. **Security note:** a GitHub personal access token and a Google Places API key were both exposed in chat/screenshots at various points during this build and were rotated. Always rotate a credential immediately if it's ever pasted somewhere it shouldn't be — don't wait.

---

## Quick reference: full env var list

**Netlify (Site Settings → Environment variables):**
`GROQ_API_KEY`, `GITHUB_TOKEN`, `GITHUB_USERNAME`, `GITHUB_REPO`, `SITE_URL`
*(Dodo-related vars exist but are currently unused — payment gateway is off)*

**GitHub Actions (Settings → Secrets and variables → Actions):**
`PLACES_API_KEY`, `BREVO_USERNAME`, `BREVO_PASSWORD`, `FROM_EMAIL`, `PAGESPEED_API_KEY` (optional — enables real performance scores), `BRAVE_API_KEY` (optional — not yet set, needs a card; crt.sh is the free fallback while this is missing)
