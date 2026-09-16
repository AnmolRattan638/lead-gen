// ============================================================
// NETLIFY FUNCTION: suggest-categories
// ============================================================
// Lives at: netlify/functions/suggest-categories.js
// Called by the signup form's JavaScript via fetch("/.netlify/functions/suggest-categories")
//
// This keeps the Gemini API key safe on the server side — it never
// appears in the browser's page source, unlike the GitHub token (which
// is a deliberate, accepted tradeoff for that specific piece, scoped
// tightly to one repo). Gemini's free tier has real usage limits, so
// keeping this key hidden protects it from being drained by anyone
// viewing the page source.
//
// SETUP REQUIRED (in Netlify dashboard, not in this file):
//   Site Settings → Environment variables → add GEMINI_API_KEY
// ============================================================

exports.handler = async function (event) {
  // Only accept POST requests — reject anything else cleanly
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
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

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server not configured — missing API key" }),
    };
  }

  const prompt = `A freelancer describes their service/role as: "${role}"

Suggest 5-8 specific types of LOCAL BUSINESSES this freelancer should search for as potential clients, using Google Maps business categories (e.g. "wedding venues", "yoga studios", "dental clinics"). These should be businesses that would realistically need or benefit from this freelancer's service.

Respond with ONLY a comma-separated list of business categories, nothing else — no explanation, no numbering, no extra text. Example format: wedding venues, bridal boutiques, event planners, photography studios`;

  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Gemini API error:", errorText);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "AI suggestion service unavailable" }),
      };
    }

    const data = await response.json();
    const suggestionText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

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
    console.error("Function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Something went wrong generating suggestions" }),
    };
  }
};
