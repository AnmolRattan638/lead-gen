// ============================================================
// NETLIFY FUNCTION: create-payment-link  (now backed by Dodo Payments)
// ============================================================
// Lives at: netlify/functions/create-payment-link.js
// Called by the signup form right after submit-signup succeeds, via
// fetch("/.netlify/functions/create-payment-link")
//
// SWITCHED FROM RAZORPAY TO DODO PAYMENTS — Razorpay's live-mode KYC
// requires a video call while holding your physical PAN card; Dodo's
// verification process doesn't have that specific requirement.
//
// Generates a Dodo Payments checkout session for a newly-signed-up
// (but not yet active) client. client_id travels through as metadata
// so dodo-webhook.js can activate the right client once paid.
//
// PRICING NOTE: this uses ONE pre-created, fixed-price product for now
// (the flexible "any amount above a floor" idea is on hold — Dodo's
// model is catalog/product based, not raw-amount based like Razorpay's
// Payment Links, so that would need either several preset tier
// products or creating a throwaway product per checkout at the exact
// negotiated price — doable later if still wanted).
//
// SETUP REQUIRED:
//   1. In your project root: npm install dodopayments
//      Commit the resulting package.json + package-lock.json — Netlify
//      installs listed dependencies automatically during deploy.
//   2. In the Dodo dashboard, create ONE product for your monthly plan
//      (fixed price), copy its product_id.
//   3. Netlify env vars (Site Settings → Environment variables):
//        DODO_PAYMENTS_API_KEY
//        DODO_PAYMENTS_ENVIRONMENT = test_mode   (switch to live_mode when ready)
//        DODO_PRODUCT_ID           = the product_id from step 2
//        SITE_URL                  = e.g. https://client-signup-form.netlify.app
// ============================================================

const DodoPayments = require("dodopayments");

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

  const DODO_PAYMENTS_API_KEY = process.env.DODO_PAYMENTS_API_KEY;
  const DODO_PAYMENTS_ENVIRONMENT = process.env.DODO_PAYMENTS_ENVIRONMENT || "test_mode";
  const DODO_PRODUCT_ID = process.env.DODO_PRODUCT_ID;
  const SITE_URL = process.env.SITE_URL;

  if (!DODO_PAYMENTS_API_KEY || !DODO_PRODUCT_ID || !SITE_URL) {
    console.error("Missing Dodo Payments server configuration — check Netlify environment variables.");
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Payment system not configured correctly" }),
    };
  }

  try {
    const client = new DodoPayments({
      bearerToken: DODO_PAYMENTS_API_KEY,
      environment: DODO_PAYMENTS_ENVIRONMENT,
    });

    const session = await client.checkoutSessions.create({
      product_cart: [{ product_id: DODO_PRODUCT_ID, quantity: 1 }],
      customer: { email: email, name: name || "Client" },
      return_url: `${SITE_URL}/client-config.html?client_id=${encodeURIComponent(client_id)}&email=${encodeURIComponent(email)}`,
      metadata: { client_id: client_id },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ payment_link: session.checkout_url }),
    };
  } catch (err) {
    console.error("create-payment-link (Dodo) error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Something went wrong creating the payment link" }),
    };
  }
};
