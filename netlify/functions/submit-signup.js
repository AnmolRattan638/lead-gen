// ============================================================
// NETLIFY FUNCTION: submit-signup
// ============================================================
// Lives at: netlify/functions/submit-signup.js
// Called by the signup form's JavaScript via fetch("/.netlify/functions/submit-signup")
//
// UPDATED: new clients are now created with active: false. Signing up
// no longer means the pipeline runs — it only turns on once Razorpay
// confirms payment via razorpay-webhook.js. Because of this, the
// "entry" audit-log event is also no longer written here — it's only
// written by the webhook, once someone has actually paid. That keeps
// "New Signups" on the dashboard meaning real paying clients, not
// everyone who filled out a form.
//
// SETUP REQUIRED (in Netlify dashboard, not in this file):
//   Site Settings → Environment variables → add:
//     GITHUB_TOKEN    = your fine-grained personal access token
//     GITHUB_USERNAME = your GitHub username
//     GITHUB_REPO     = the repo name (e.g. lead-gen)
// ============================================================

const REGISTRY_PATH = "clients_registry.json";

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

  const newClient = {
    name: clientData.name || "Unnamed Client",
    email: clientData.email,
    cities: clientData.cities,
    categories: clientData.categories,
    daily_lead_cap: Math.min(parseInt(clientData.daily_lead_cap, 10) || 20, 20),
    min_reviews: parseInt(clientData.min_reviews, 10) || 40,
    require_website: !!clientData.require_website, // false = show only businesses without a proper website
    require_ecommerce_platform: !!clientData.require_ecommerce_platform, // true = only businesses with a detected online store
    recently_opened_only: !!clientData.recently_opened_only, // true = swap the normal min_reviews search for the recently-opened scanner
    active: false, // stays off until Razorpay confirms payment (see razorpay-webhook.js)
  };

  try {
    // Add the new (inactive) client to the registry. No audit-log entry
    // is written here anymore — that now happens only once payment is
    // confirmed, so the log reflects real paying clients, not signups.
    const registryFile = await getFile(REGISTRY_PATH, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN);
    const registry = registryFile.content || {};
    registry[clientId] = newClient;
    await putFile(
      REGISTRY_PATH,
      registry,
      registryFile.sha,
      `Add ${clientId} to registry via signup (pending payment)`,
      GITHUB_USERNAME,
      GITHUB_REPO,
      GITHUB_TOKEN
    );

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
