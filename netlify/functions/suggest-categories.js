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
// SETUP REQUIRED (in Netlify dashboard, not in this file):
//   Site Settings → Environment variables → add GROQ_API_KEY
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
