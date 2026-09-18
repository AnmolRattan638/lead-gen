// ============================================================
// NETLIFY FUNCTION: create-payment-link
// ============================================================
// Lives at: netlify/functions/create-payment-link.js
// Called by the signup form right after submit-signup succeeds, via
// fetch("/.netlify/functions/create-payment-link")
//
// Generates a Razorpay Payment Link for a newly-signed-up (but not yet
// active) client. The signup page redirects the user to this link
// instead of straight to client-config.html — the pipeline only turns
// on once Razorpay confirms payment via razorpay-webhook.js.
//
// SETUP REQUIRED (in Netlify dashboard, not in this file):
//   Site Settings → Environment variables → add:
//     RAZORPAY_KEY_ID      = from Razorpay dashboard → API Keys
//     RAZORPAY_KEY_SECRET  = from Razorpay dashboard → API Keys
//     RAZORPAY_AMOUNT_INR  = monthly price in whole rupees, e.g. 1999
//     SITE_URL             = e.g. https://client-signup-form.netlify.app
// ============================================================

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

  const { client_id, name, email } = body;
  if (!client_id || !email) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing client_id or email" }),
    };
  }

  const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
  const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
  const SITE_URL = process.env.SITE_URL;
  const amountInRupees = parseInt(process.env.RAZORPAY_AMOUNT_INR, 10) || 1999;

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET || !SITE_URL) {
    console.error("Missing Razorpay server configuration — check Netlify environment variables.");
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Payment system not configured correctly" }),
    };
  }

  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");

  const payload = {
    amount: amountInRupees * 100, // Razorpay expects paise, not rupees
    currency: "INR",
    accept_partial: false,
    description: `Lead Pipeline — Monthly (${client_id})`,
    customer: {
      name: name || "Client",
      email: email,
    },
    notify: { email: true, sms: false },
    reminder_enable: true,
    // reference_id is how the webhook maps a completed payment back to
    // this exact client — Razorpay echoes it back in the webhook payload.
    reference_id: client_id,
    notes: { client_id: client_id },
    callback_url: `${SITE_URL}/client-config.html?client_id=${encodeURIComponent(client_id)}&email=${encodeURIComponent(email)}`,
    callback_method: "get",
  };

  try {
    const response = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Razorpay error:", JSON.stringify(data));
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Failed to create payment link" }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ payment_link: data.short_url }),
    };
  } catch (err) {
    console.error("create-payment-link error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Something went wrong creating the payment link" }),
    };
  }
};
