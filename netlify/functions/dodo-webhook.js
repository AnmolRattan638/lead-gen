// ============================================================
// NETLIFY FUNCTION: dodo-webhook
// ============================================================
// Lives at: netlify/functions/dodo-webhook.js
// Called automatically BY DODO PAYMENTS the moment a checkout is paid.
// Replaces razorpay-webhook.js.
//
// SECURITY: Dodo signs every webhook using Svix (a dedicated webhook
// signing service — different mechanism from Razorpay's raw HMAC
// header). The signature is verified before anything else runs —
// without this, anyone could POST a fake "payment succeeded" event
// and activate themselves for free.
//
// SETUP REQUIRED:
//   1. In your project root: npm install svix
//      Commit the resulting package.json + package-lock.json.
//   2. Netlify env vars:
//        DODO_WEBHOOK_SECRET = from Dodo dashboard → Developer → Webhooks
//        GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_REPO  (already set)
//   3. In the Dodo dashboard → Developer → Webhooks:
//        URL: https://<your-site>.netlify.app/.netlify/functions/dodo-webhook
//        Events: enable the successful one-time-payment event — confirm
//        its exact name in your dashboard (this code checks for
//        "payment.succeeded"; adjust the check below if yours differs).
//
// FIRST TEST PAYMENT: watch this function's log in Netlify. It prints
// the verified event type and, if client_id can't be found, the full
// payload — use that to confirm/adjust the event name and metadata
// path below, since Dodo's exact payload shape has varied slightly
// across SDK versions in their own docs.
// ============================================================

const { Webhook } = require("svix");

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
  return { content: JSON.parse(b64DecodeUnicode(fileData.content)), sha: fileData.sha };
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
    return { statusCode: 405, body: "Method not allowed" };
  }

  const DODO_WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
  const GITHUB_REPO = process.env.GITHUB_REPO;

  if (!DODO_WEBHOOK_SECRET || !GITHUB_TOKEN || !GITHUB_USERNAME || !GITHUB_REPO) {
    console.error("Missing server configuration — check Netlify environment variables.");
    return { statusCode: 500, body: "Server not configured correctly" };
  }

  const rawBody = event.body || "";
  const svixHeaders = {
    "svix-id": event.headers["svix-id"],
    "svix-timestamp": event.headers["svix-timestamp"],
    "svix-signature": event.headers["svix-signature"],
  };

  let payload;
  try {
    const wh = new Webhook(DODO_WEBHOOK_SECRET);
    payload = wh.verify(rawBody, svixHeaders); // throws on invalid signature
  } catch (err) {
    console.error("Webhook signature verification FAILED:", err.message);
    return { statusCode: 400, body: "Invalid signature" };
  }

  const eventType = payload.type || payload.event_type;
  console.log("Verified Dodo webhook event:", eventType);

  if (eventType !== "payment.succeeded") {
    return { statusCode: 200, body: "Ignored (not a payment.succeeded event)" };
  }

  // Metadata's exact location has varied across Dodo's own docs examples —
  // check both likely spots, and log the full payload if neither hits so
  // this is a two-minute fix on your very first real test payment.
  const data = payload.data || {};
  const clientId =
    (data.metadata && data.metadata.client_id) ||
    (data.payment && data.payment.metadata && data.payment.metadata.client_id);

  if (!clientId) {
    console.error("No client_id found in webhook payload — full payload:", JSON.stringify(payload));
    return { statusCode: 200, body: "No client_id found in payload" };
  }

  try {
    const registryFile = await getFile(REGISTRY_PATH, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN);
    const registry = registryFile.content || {};
    const client = registry[clientId];

    if (!client) {
      console.error(`Webhook: client_id ${clientId} not found in registry.`);
      return { statusCode: 200, body: "Client not found — nothing to activate" };
    }

    if (client.active) {
      // Likely a duplicate webhook delivery — acknowledge without
      // double-logging an entry event.
      return { statusCode: 200, body: "Already active — no action needed" };
    }

    client.active = true;
    registry[clientId] = client;
    await putFile(
      REGISTRY_PATH,
      registry,
      registryFile.sha,
      `Activate ${clientId} after confirmed Dodo payment`,
      GITHUB_USERNAME,
      GITHUB_REPO,
      GITHUB_TOKEN
    );

    const logFile = await getFile(LOG_PATH, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN);
    const log = Array.isArray(logFile.content) ? logFile.content : [];
    log.push({
      event: "entry",
      client_id: clientId,
      name: client.name,
      email: client.email,
      cities: client.cities,
      timestamp: new Date().toISOString(),
    });
    await putFile(
      LOG_PATH,
      log,
      logFile.sha,
      `Log entry event for ${clientId} (Dodo payment confirmed)`,
      GITHUB_USERNAME,
      GITHUB_REPO,
      GITHUB_TOKEN
    );

    console.log(`Activated ${clientId} after confirmed Dodo payment.`);
    return { statusCode: 200, body: "Client activated" };
  } catch (err) {
    console.error("dodo-webhook error:", err);
    return { statusCode: 500, body: "Internal error" };
  }
};
