// ============================================================
// NETLIFY FUNCTION: get-client
// ============================================================
// Lives at: netlify/functions/get-client.js
// Called by client-config.html via
// fetch("/.netlify/functions/get-client?client_id=client_8018")
//
// Replaces the old client-side GitHub API call that shipped a live
// GitHub token to the browser. The token now stays server-side only.
//
// SETUP REQUIRED (in Netlify dashboard, not in this file):
//   Site Settings → Environment variables → add:
//     GITHUB_TOKEN    = your fine-grained personal access token
//     GITHUB_USERNAME = your GitHub username
//     GITHUB_REPO     = the repo name (e.g. lead-gen)
// ============================================================

const REGISTRY_PATH = "clients_registry.json";

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

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const clientId = event.queryStringParameters && event.queryStringParameters.client_id;
  if (!clientId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing client_id query parameter" }),
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

  try {
    const registry = (await getFile(REGISTRY_PATH, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN)) || {};
    const client = registry[clientId];

    if (!client) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Client not found" }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(client),
    };
  } catch (err) {
    console.error("get-client error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Lookup failed" }),
    };
  }
};
