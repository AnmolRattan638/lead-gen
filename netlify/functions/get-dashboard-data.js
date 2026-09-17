// ============================================================
// NETLIFY FUNCTION: get-dashboard-data
// ============================================================
// Lives at: netlify/functions/get-dashboard-data.js
// Called by AR_Designs_Client_Pipeline.html via
// fetch("/.netlify/functions/get-dashboard-data")
//
// Reads clients_registry.json and signups_log.json server-side and
// returns only aggregated stats — client emails and other raw fields
// never reach the browser, even though the source files live in GitHub.
//
// SETUP REQUIRED: same env vars as submit-signup.js
//   GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_REPO
// ============================================================

const REGISTRY_PATH = "clients_registry.json";
const LOG_PATH = "signups_log.json";

function b64DecodeUnicode(str) {
  return Buffer.from(str, "base64").toString("utf-8");
}

async function getFile(path, owner, repo, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GitHub GET ${path} failed (${response.status}): ${errText}`);
  }

  const fileData = await response.json();
  return JSON.parse(b64DecodeUnicode(fileData.content));
}

function dayKey(dateInput) {
  return new Date(dateInput).toISOString().slice(0, 10); // YYYY-MM-DD
}

exports.handler = async function () {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
  const GITHUB_REPO = process.env.GITHUB_REPO;

  if (!GITHUB_TOKEN || !GITHUB_USERNAME || !GITHUB_REPO) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server not configured correctly" }),
    };
  }

  try {
    const [registry, log] = await Promise.all([
      getFile(REGISTRY_PATH, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN),
      getFile(LOG_PATH, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN),
    ]);

    const safeRegistry = registry || {};
    const safeLog = Array.isArray(log) ? log : [];

    // --- Active clients ---
    const activeEntries = Object.entries(safeRegistry).filter(([, c]) => c.active);
    const activeClients = activeEntries.length;

    // --- New signups this week / total removed ---
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const newSignupsThisWeek = safeLog.filter(
      (e) => e.event === "entry" && new Date(e.timestamp).getTime() >= oneWeekAgo
    ).length;
    const totalRemoved = safeLog.filter((e) => e.event === "exit").length;

    // --- City breakdown (active clients only) ---
    const cityCounts = {};
    activeEntries.forEach(([, c]) => {
      (c.cities || []).forEach((city) => {
        cityCounts[city] = (cityCounts[city] || 0) + 1;
      });
    });
    const cityBreakdown = Object.entries(cityCounts)
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    // --- Activity feed (most recent first, capped at 50) ---
    const activity = safeLog
      .slice()
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 50)
      .map((e) => ({
        event: e.event,
        client_id: e.client_id,
        name: e.name || "Unnamed Client",
        city: Array.isArray(e.cities) && e.cities.length ? e.cities[0] : "—",
        timestamp: e.timestamp,
      }));

    // --- 30-day velocity chart data ---
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      days.push(dayKey(d));
    }
    const dayBuckets = Object.fromEntries(days.map((d) => [d, { entries: 0, exits: 0 }]));
    safeLog.forEach((e) => {
      const key = dayKey(e.timestamp);
      if (dayBuckets[key]) {
        if (e.event === "entry") dayBuckets[key].entries += 1;
        if (e.event === "exit") dayBuckets[key].exits += 1;
      }
    });
    const chartData = days.map((d) => ({ date: d, ...dayBuckets[d] }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        activeClients,
        newSignupsThisWeek,
        totalRemoved,
        cityBreakdown,
        activity,
        chartData,
        updatedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error("Dashboard data error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to load dashboard data" }),
    };
  }
};
