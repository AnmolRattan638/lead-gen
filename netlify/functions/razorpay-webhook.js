// ============================================================
// NETLIFY FUNCTION: razorpay-webhook
// ============================================================
// Lives at: netlify/functions/razorpay-webhook.js
// Called automatically BY RAZORPAY — not by your frontend — the moment
// a payment link is paid. This is what turns a client's pipeline on
// without you having to check anything manually.
//
// SECURITY: every incoming request's signature is verified against
// RAZORPAY_WEBHOOK_SECRET before anything else happens. Without this
// check, anyone could POST a fake "payment succeeded" request and
// activate themselves for free — the signature is what proves the
// request genuinely came from Razorpay.
//
// SETUP REQUIRED:
//   1. Netlify env vars (Site Settings → Environment variables):
//        RAZORPAY_WEBHOOK_SECRET = a secret string YOU create
//        GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_REPO  (already set)
//   2. In the Razorpay Dashboard → Settings → Webhooks:
//        URL:    https://<your-site>.netlify.app/.netlify/functions/razorpay-webhook
//        Secret: the SAME string you put in RAZORPAY_WEBHOOK_SECRET above
//        Active events: check "payment_link.paid"
// ============================================================

const crypto = require("crypto");

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

function isValidSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(signatureHeader, "utf-8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
  const GITHUB_REPO = process.env.GITHUB_REPO;

  if (!RAZORPAY_WEBHOOK_SECRET || !GITHUB_TOKEN || !GITHUB_USERNAME || !GITHUB_REPO) {
    console.error("Missing server configuration — check Netlify environment variables.");
    return { statusCode: 500, body: "Server not configured correctly" };
  }

  const signatureHeader = event.headers["x-razorpay-signature"] || event.headers["X-Razorpay-Signature"];
  const rawBody = event.body || "";

  if (!isValidSignature(rawBody, signatureHeader, RAZORPAY_WEBHOOK_SECRET)) {
    console.error("Webhook signature verification FAILED — rejecting request.");
    return { statusCode: 400, body: "Invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // We only act on payment_link.paid — everything else is acknowledged
  // with 200 so Razorpay doesn't keep retrying, but ignored.
  if (payload.event !== "payment_link.paid") {
    return { statusCode: 200, body: "Ignored (not a payment_link.paid event)" };
  }

  const linkEntity = payload.payload && payload.payload.payment_link && payload.payload.payment_link.entity;
  const clientId =
    (linkEntity && linkEntity.reference_id) ||
    (linkEntity && linkEntity.notes && linkEntity.notes.client_id);

  if (!clientId) {
    console.error("Webhook payload had no reference_id/client_id — cannot activate anyone.");
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
      // Already active — likely a duplicate webhook delivery, which
      // Razorpay does retry sometimes. Acknowledge without double-logging.
      return { statusCode: 200, body: "Already active — no action needed" };
    }

    client.active = true;
    registry[clientId] = client;
    await putFile(
      REGISTRY_PATH,
      registry,
      registryFile.sha,
      `Activate ${clientId} after confirmed payment`,
      GITHUB_USERNAME,
      GITHUB_REPO,
      GITHUB_TOKEN
    );

    // This is the FIRST time this client counts as a real "entry" in the
    // audit trail — signup alone no longer logs one, since signing up
    // doesn't mean paying.
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
      `Log entry event for ${clientId} (payment confirmed)`,
      GITHUB_USERNAME,
      GITHUB_REPO,
      GITHUB_TOKEN
    );

    console.log(`Activated ${clientId} after confirmed Razorpay payment.`);
    return { statusCode: 200, body: "Client activated" };
  } catch (err) {
    console.error("razorpay-webhook error:", err);
    // Return 500 so Razorpay retries — this is a real failure, not
    // something to silently swallow.
    return { statusCode: 500, body: "Internal error" };
  }
};
