// ============================================================
// NETLIFY FUNCTION: save-client-config
// ============================================================
// Lives at: netlify/functions/save-client-config.js
// Called by client-config.html's Deploy button via
// fetch("/.netlify/functions/save-client-config")
//
// Replaces the old client-side GitHub repository_dispatch call that
// shipped a live GitHub token to the browser. The token now stays
// server-side only.
//
// Also closes the "exit" logging gap: whenever a client's `active`
// flag flips from true to false (deactivated here), an "exit" event
// is appended to signups_log.json — this is what makes the dashboard's
// "Total Removed" stat and activity feed actually meaningful, since
// nothing else in the system currently logs a client leaving.
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

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  const clientId = body.client_id;
  if (!clientId || !body.email || !Array.isArray(body.cities) || body.cities.length === 0 ||
      !Array.isArray(body.categories) || body.categories.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing required fields (client_id, email, cities, categories)" }),
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

  const newClientData = {
    name: body.name || "Unnamed Client",
    email: body.email,
    cities: body.cities,
    categories: body.categories,
    daily_lead_cap: Math.min(parseInt(body.daily_lead_cap, 10) || 20, 20),
    min_reviews: parseInt(body.min_reviews, 10) || 0,
    active: !!body.active,
  };

  try {
    // 1. Load current registry, figure out what kind of transition this is
    const registryFile = await getFile(REGISTRY_PATH, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN);
    const registry = registryFile.content || {};
    const existing = registry[clientId];

    // SECURITY: if this client already exists, the submitted email must
    // match what's on file — otherwise anyone who finds/guesses a
    // client_id could overwrite someone else's real data. This means
    // email can't be changed through this form; that's an intentional
    // trade-off until a proper account-change flow exists.
    if (existing && (existing.email || "").trim().toLowerCase() !== (body.email || "").trim().toLowerCase()) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: "Email does not match the client on file" }),
      };
    }

    const previousActive = existing ? !!existing.active : undefined;
    const newActive = newClientData.active;

    let logEvent = null;
    if (!existing) {
      logEvent = "entry"; // brand new client created directly from the config page
    } else if (previousActive === true && newActive === false) {
      logEvent = "exit"; // deactivated
    } else if (previousActive === false && newActive === true) {
      logEvent = "entry"; // reactivated
    }

    // 2. Write the updated registry
    registry[clientId] = newClientData;
    await putFile(
      REGISTRY_PATH,
      registry,
      registryFile.sha,
      `Update ${clientId} config`,
      GITHUB_USERNAME,
      GITHUB_REPO,
      GITHUB_TOKEN
    );

    // 3. Log the transition, if any, to the audit trail
    if (logEvent) {
      const logFile = await getFile(LOG_PATH, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN);
      const log = Array.isArray(logFile.content) ? logFile.content : [];
      log.push({
        event: logEvent,
        client_id: clientId,
        name: newClientData.name,
        email: newClientData.email,
        cities: newClientData.cities,
        timestamp: new Date().toISOString(),
      });
      await putFile(
        LOG_PATH,
        log,
        logFile.sha,
        `Log ${logEvent} event for ${clientId}`,
        GITHUB_USERNAME,
        GITHUB_REPO,
        GITHUB_TOKEN
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, client_id: clientId }),
    };
  } catch (err) {
    console.error("save-client-config error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Something went wrong saving the config" }),
    };
  }
};
