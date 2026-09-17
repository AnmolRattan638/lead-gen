// ============================================================
// NETLIFY FUNCTION: submit-signup
// ============================================================
// Lives at: netlify/functions/submit-signup.js
// Called by the signup form's JavaScript via fetch("/.netlify/functions/submit-signup")
//
// UPDATED: now writes directly to clients_registry.json AND appends
// an entry to signups_log.json — an append-only audit trail used by
// the monitoring dashboard to show entry/exit history over time.
// The repository_dispatch event is still fired afterward in case any
// existing GitHub Action depends on it for other automation (e.g. the
// lead-search bot) — but registry/log writes no longer depend on it.
//
// SETUP REQUIRED (in Netlify dashboard, not in this file):
//   Site Settings → Environment variables → add:
//     GITHUB_TOKEN    = your fine-grained personal access token
//     GITHUB_USERNAME = your GitHub username
//     GITHUB_REPO     = the repo name (e.g. lead-gen)
// ============================================================

const REGISTRY_PATH = "clients_registry.json";
const LOG_PATH = "signups_log.json";

function b64EncodeUnicode(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

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

  if (response.status === 404) {
    return { content: null, sha: null };
  }
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GitHub GET ${path} failed (${response.status}): ${errText}`);
  }

  const fileData = await response.json();
  const decoded = b64DecodeUnicode(fileData.content);
  return { content: JSON.parse(decoded), sha: fileData.sha };
}

async function putFile(path, contentObj, sha, message, owner, repo, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const body = {
    message,
    content: b64EncodeUnicode(JSON.stringify(contentObj, null, 2)),
  };
  if (sha) body.sha = sha;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GitHub PUT ${path} failed (${response.status}): ${errText}`);
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  let clientData;
  try {
    clientData = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  if (!clientData.email || !Array.isArray(clientData.cities) || clientData.cities.length === 0 ||
      !Array.isArray(clientData.categories) || clientData.categories.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing required fields (email, cities, categories)" }),
    };
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
  const GITHUB_REPO = process.env.GITHUB_REPO;

  if (!GITHUB_TOKEN || !GITHUB_USERNAME || !GITHUB_REPO) {
    console.error("Missing server configuration — check Netlify environment variables.");
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server not configured correctly" }),
    };
  }

  const clientId = "client_" + Math.floor(1000 + Math.random() * 9000);
  const timestamp = new Date().toISOString();

  const newClient = {
    name: clientData.name || "Unnamed Client",
    email: clientData.email,
    cities: clientData.cities,
    categories: clientData.categories,
    daily_lead_cap: Math.min(parseInt(clientData.daily_lead_cap, 10) || 20, 20),
    min_reviews: parseInt(clientData.min_reviews, 10) || 40,
    active: true,
  };

  try {
    // 1. Add the new client to the registry (current-state source of truth)
    const registryFile = await getFile(REGISTRY_PATH, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN);
    const registry = registryFile.content || {};
    registry[clientId] = newClient;
    await putFile(
      REGISTRY_PATH,
      registry,
      registryFile.sha,
      `Add ${clientId} to registry via signup`,
      GITHUB_USERNAME,
      GITHUB_REPO,
      GITHUB_TOKEN
    );

    // 2. Append an entry event to the audit log (never overwritten, only
    // ever added to — this is what the monitoring dashboard reads).
    const logFile = await getFile(LOG_PATH, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN);
    const log = Array.isArray(logFile.content) ? logFile.content : [];
    log.push({
      event: "entry",
      client_id: clientId,
      name: newClient.name,
      email: newClient.email,
      cities: newClient.cities,
      timestamp,
    });
    await putFile(
      LOG_PATH,
      log,
      logFile.sha,
      `Log entry event for ${clientId}`,
      GITHUB_USERNAME,
      GITHUB_REPO,
      GITHUB_TOKEN
    );

    // 3. Fire the existing dispatch event too, in case other automation
    // (e.g. the lead-search bot workflow) still depends on it. Failure
    // here is logged but doesn't fail the signup — the registry/log
    // writes above already succeeded and are what actually matters.
    try {
      const dispatchUrl = `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/dispatches`;
      await fetch(dispatchUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "new_client_signup",
          client_payload: { client_id: clientId, ...newClient },
        }),
      });
    } catch (dispatchErr) {
      console.error("Dispatch event failed (non-fatal):", dispatchErr);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, client_id: clientId }),
    };
  } catch (err) {
    console.error("Function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Something went wrong submitting your signup" }),
    };
  }
};
