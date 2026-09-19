// ============================================================
// NETLIFY FUNCTION: suggest-categories
// ============================================================
// Lives at: netlify/functions/suggest-categories.js
// Called by the signup form's JavaScript via fetch("/.netlify/functions/suggest-categories")
//
// Switched from Gemini to Groq — Gemini's API was hanging/timing out
// on every server-side call regardless of key or network path. Groq
// uses an OpenAI-compatible endpoint, free tier, no billing required.
//
// RATE LIMITED: this endpoint has no client_id/email to check against
// (it's called before signup even completes), so anyone who finds the
// URL could otherwise hit it directly and burn Groq credits for free.
// Limits each IP to MAX_REQUESTS_PER_WINDOW calls per WINDOW_MINUTES,
// tracked in rate_limits.json in this same repo — reusing the same
// GitHub-as-storage pattern as everything else here, so no new paid
// service is needed at current traffic levels.
//
// HONEST LIMITATION: this adds a GitHub API read+write to every call
// (a few hundred ms of latency), and shares GitHub's 5,000 req/hour
// API quota with your other functions. Fine at today's traffic; if
// this ever gets busy, swap this file's storage for something faster
// (Netlify Blobs, Upstash Redis) — the rate-limit logic itself doesn't
// need to change, just where it reads/writes.
//
// SETUP REQUIRED (in Netlify dashboard, not in this file):
//   Site Settings → Environment variables → add GROQ_API_KEY
//   (GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_REPO already set)
// ============================================================

const RATE_LIMIT_PATH = "rate_limits.json";
const MAX_REQUESTS_PER_WINDOW = 10;
const WINDOW_MINUTES = 60;

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
  if (response.status === 404) return { content: null, sha: null };
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GitHub GET ${path} failed (${response.status}): ${errText}`);
  }
  const fileData = await response.json();
  return { content: JSON.parse(b64DecodeUnicode(fileData.content)), sha: fileData.sha };
}

async function putFile(path, contentObj, sha, message, owner, repo, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const body = { message, content: b64EncodeUnicode(JSON.stringify(contentObj, null, 2)) };
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

// Returns { allowed: bool, sha } — sha is passed through so the caller
// can write the updated counts back without a second read.
async function checkAndRecordRequest(ip, owner, repo, token) {
  const file = await getFile(RATE_LIMIT_PATH, owner, repo, token);
  const limits = file.content || {};
  const now = Date.now();
  const windowMs = WINDOW_MINUTES * 60 * 1000;

  const entry = limits[ip];
  if (!entry || now - entry.windowStart > windowMs) {
    limits[ip] = { count: 1, windowStart: now };
    await putFile(RATE_LIMIT_PATH, limits, file.sha, `Rate limit: reset window for ${ip}`, owner, repo, token);
    return true;
  }

  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    return false; // over limit — don't even bother writing back
  }

  entry.count += 1;
  limits[ip] = entry;
  await putFile(RATE_LIMIT_PATH, limits, file.sha, `Rate limit: increment for ${ip}`, owner, repo, token);
  return true;
}

exports.handler = async function (event) {
  // Only accept POST requests — reject anything else cleanly
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
  const GITHUB_REPO = process.env.GITHUB_REPO;
  const ip =
    (event.headers["x-nf-client-connection-ip"]) ||
    (event.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown";

  if (GITHUB_TOKEN && GITHUB_USERNAME && GITHUB_REPO) {
    try {
      const allowed = await checkAndRecordRequest(ip, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN);
      if (!allowed) {
        console.error(`Rate limit exceeded for IP ${ip}`);
        return {
          statusCode: 429,
          body: JSON.stringify({ error: "Too many requests — please try again later" }),
        };
      }
    } catch (err) {
      // If the rate limiter itself fails, log it but don't block real
      // users over an infra hiccup — fail open, not closed.
      console.error("Rate limiter error (failing open):", err);
    }
  } else {
    console.error("Rate limiting skipped — GitHub env vars not configured.");
  }

  let role;
  try {
    const body = JSON.parse(event.body);
    role = (body.role || "").trim();
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  if (!role) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Role/service is required" }),
    };
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server not configured — missing API key" }),
    };
  }

  const prompt = `A freelancer describes their service/role as: "${role}"

Suggest 5-8 specific types of LOCAL BUSINESSES this freelancer should search for as potential clients, using Google Maps business categories (e.g. "wedding venues", "yoga studios", "dental clinics"). These should be businesses that would realistically need or benefit from this freelancer's service.

Respond with ONLY a comma-separated list of business categories, nothing else — no explanation, no numbering, no extra text. Example format: wedding venues, bridal boutiques, event planners, photography studios`;

  try {
    const groqUrl = "https://api.groq.com/openai/v1/chat/completions";

    console.log("Calling Groq API for role:", role);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let response;
    try {
      response = await fetch(groqUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    console.log("Groq responded with status:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Groq API error body:", errorText);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "AI suggestion service unavailable" }),
      };
    }

    const data = await response.json();
    console.log("Groq raw response:", JSON.stringify(data));

    const suggestionText = data.choices?.[0]?.message?.content?.trim() || "";

    // Parse the comma-separated response into a clean array, trimming
    // whitespace and dropping any empty entries from stray formatting.
    const categories = suggestionText
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    return {
      statusCode: 200,
      body: JSON.stringify({ categories }),
    };
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("Groq API call timed out after 8s");
      return {
        statusCode: 504,
        body: JSON.stringify({ error: "AI service timed out" }),
      };
    }
    console.error("Function error:", err.name, err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Something went wrong generating suggestions" }),
    };
  }
};
