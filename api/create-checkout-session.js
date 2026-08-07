import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

const PRODUCTS = Object.freeze({
  "PP-001": {
    name: "First You Shake It",
    unitAmount: 400,
    stockLimit: 50,
  },
  "PP-002": {
    name: "Major League Toprails",
    unitAmount: 400,
    stockLimit: 50,
  },
  "PP-003": {
    name: "Pipe Pilot Mountain",
    unitAmount: 300,
    stockLimit: 50,
  },
});

const SHIPPING_AMOUNT = 499;
const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://pipepilotapp.com",
  "https://www.pipepilotapp.com",
];

function allowedOrigins() {
  const configured = process.env.ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configured?.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };

  if (origin && allowedOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function jsonResponse(body, status, origin) {
  return Response.json(body, {
    status,
    headers: corsHeaders(origin),
  });
}

function normalizeCart(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("Your cart is empty.");
  }

  const merged = new Map();

  for (const rawItem of rawItems) {
    const sku = String(rawItem?.sku ?? "").trim();
    const quantity = Number(rawItem?.quantity);
    const product = PRODUCTS[sku];

    if (!product) {
      throw new Error(`Unknown product: ${sku || "missing SKU"}.`);
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`Invalid quantity for ${sku}.`);
    }

    const nextQuantity = (merged.get(sku) ?? 0) + quantity;

    if (nextQuantity > product.stockLimit) {
      throw new Error(
        `${product.name} is limited to ${product.stockLimit} per checkout.`
      );
    }

    merged.set(sku, nextQuantity);
  }

  return [...merged.entries()].map(([sku, quantity]) => ({
    sku,
    quantity,
    product: PRODUCTS[sku],
  }));
}

export function OPTIONS(request) {
  const origin = request.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

export async function POST(request) {
  const origin = request.headers.get("origin");

  if (!origin || !allowedOrigins().includes(origin)) {
    return jsonResponse({ error: "Origin not allowed." }, 403, origin);
  }

  if (!stripeSecretKey) {
    console.error("STRIPE_SECRET_KEY is not configured.");
    return jsonResponse(
      { error: "Checkout is temporarily unavailable." },
      500,
      origin
    );
  }

  try {
    const payload = await request.json();
    const cart = normalizeCart(payload?.items);
    const stripe = new Stripe(stripeSecretKey);

    const lineItems = cart.map(({ sku, quantity, product }) => ({
      quantity,
      price_data: {
        currency: "cad",
        unit_amount: product.unitAmount,
        product_data: {
          name: product.name,
          metadata: { sku },
        },
      },
    }));

    const cartReference = cart
      .map(({ sku, quantity }) => `${sku}:${quantity}`)
      .join(",");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      managed_payments: {
        enabled: false,
  },
  line_items: lineItems,
      shipping_address_collection: {
        allowed_countries: ["CA"],
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: {
              amount: SHIPPING_AMOUNT,
              currency: "cad",
            },
            display_name: "Shipping & handling",
          },
        },
      ],
      customer_creation: "always",
      billing_address_collection: "auto",
      phone_number_collection: {
        enabled: false,
      },
      metadata: {
        source: "pipepilot-merch",
        cart: cartReference,
      },
      payment_intent_data: {
        metadata: {
          source: "pipepilot-merch",
          cart: cartReference,
        },
      },
      success_url: `${origin}/order-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/merch.html?checkout=cancelled`,
    });

    if (!session.url) {
      throw new Error("Stripe did not return a Checkout URL.");
    }

    return jsonResponse({ url: session.url }, 200, origin);
  } catch (error) {
    console.error("Checkout Session error:", error);

    const message =
      error instanceof Error ? error.message : "Unable to create checkout.";

    return jsonResponse({ error: message }, 400, origin);
  }
}
