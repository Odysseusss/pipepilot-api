import Stripe from "stripe";
import { neon } from "@neondatabase/serverless";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const databaseUrl = process.env.STORAGE_DATABASE_URL_UNPOOLED;
const sql = databaseUrl ? neon(databaseUrl) : null;

const SHIPPING_AMOUNT = 499;
const FREE_SHIPPING_THRESHOLD = 3000;

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

function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("Your cart is empty.");
  }

  const merged = new Map();

  for (const rawItem of rawItems) {
    const sku = String(rawItem?.sku ?? "").trim();
    const quantity = Number(rawItem?.quantity);

    if (!sku || !Number.isInteger(quantity) || quantity < 1) {
      throw new Error("Cart contains an invalid item.");
    }

    merged.set(sku, (merged.get(sku) ?? 0) + quantity);
  }

  return [...merged.entries()].map(([sku, quantity]) => ({ sku, quantity }));
}

async function loadCart(rawItems) {
  const requested = normalizeItems(rawItems);

  const rows = await sql`
    SELECT
      sku,
      name,
      price_cents,
      current_stock,
      active
    FROM products
    WHERE active = TRUE
  `;

  const catalog = new Map(rows.map((row) => [row.sku, row]));

  return requested.map((item) => {
    const product = catalog.get(item.sku);

    if (!product) {
      throw new Error(`Unknown or inactive product: ${item.sku}.`);
    }

    const stock = Number(product.current_stock);

    if (item.quantity > stock) {
      throw new Error(`${product.name} only has ${stock} available.`);
    }

    return {
      sku: item.sku,
      quantity: item.quantity,
      name: product.name,
      unitAmount: Number(product.price_cents),
    };
  });
}

function promoIsExpired(expiresAt) {
  return expiresAt && new Date(expiresAt).getTime() <= Date.now();
}

async function loadPromo(code, subtotalCents) {
  if (!code) {
    return null;
  }

  const rows = await sql`
    SELECT
      code,
      discount_type,
      discount_value,
      minimum_subtotal_cents,
      active,
      expires_at,
      max_uses,
      times_used
    FROM promo_codes
    WHERE code = ${code}
    LIMIT 1
  `;

  if (!rows.length) {
    throw new Error("Promo code is not valid.");
  }

  const promo = rows[0];

  if (!promo.active) {
    throw new Error("Promo code is not active.");
  }

  if (promoIsExpired(promo.expires_at)) {
    throw new Error("Promo code has expired.");
  }

  if (
    promo.max_uses !== null &&
    Number(promo.times_used) >= Number(promo.max_uses)
  ) {
    throw new Error("Promo code has reached its usage limit.");
  }

  if (subtotalCents < Number(promo.minimum_subtotal_cents ?? 0)) {
    throw new Error("Cart does not meet this promo code's minimum merchandise total.");
  }

  const type = String(promo.discount_type).toLowerCase();
  const value = Number(promo.discount_value ?? 0);

  if (type === "percent") {
    if (!Number.isFinite(value) || value <= 0 || value >= 100) {
      throw new Error("Promo percentage is not configured correctly.");
    }

    return {
      code: promo.code,
      type,
      value,
      freeShipping: false,
    };
  }

  if (type === "free_shipping") {
    return {
      code: promo.code,
      type,
      value: 0,
      freeShipping: true,
    };
  }

  throw new Error("This promo type is not supported yet.");
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
    return jsonResponse({ error: "Checkout is temporarily unavailable." }, 500, origin);
  }

  if (!databaseUrl || !sql) {
    console.error("STORAGE_DATABASE_URL_UNPOOLED is not configured.");
    return jsonResponse({ error: "Checkout inventory is temporarily unavailable." }, 500, origin);
  }

  try {
    const payload = await request.json();
    const cart = await loadCart(payload?.items);
    const stripe = new Stripe(stripeSecretKey);

    const originalSubtotalCents = cart.reduce(
      (total, item) => total + item.unitAmount * item.quantity,
      0
    );

    const promoCode = String(payload?.promoCode ?? "").trim().toUpperCase();
    const promo = await loadPromo(promoCode || null, originalSubtotalCents);

    let discountCents = 0;

    const lineItems = cart.map((item) => {
      let checkoutUnitAmount = item.unitAmount;

      if (promo?.type === "percent") {
        checkoutUnitAmount = Math.max(
          0,
          Math.round(item.unitAmount * ((100 - promo.value) / 100))
        );

        discountCents +=
          (item.unitAmount - checkoutUnitAmount) * item.quantity;
      }

      return {
        quantity: item.quantity,
        price_data: {
          currency: "cad",
          unit_amount: checkoutUnitAmount,
          product_data: {
            name: item.name,
            metadata: { sku: item.sku },
          },
        },
      };
    });

    const discountedSubtotalCents = Math.max(
      0,
      originalSubtotalCents - discountCents
    );

    const shippingAmount =
      promo?.freeShipping || discountedSubtotalCents >= FREE_SHIPPING_THRESHOLD
        ? 0
        : SHIPPING_AMOUNT;

    const cartReference = cart
      .map(({ sku, quantity }) => `${sku}:${quantity}`)
      .join(",");

    const metadata = {
      source: "pipepilot-merch",
      cart: cartReference,
      promo_code: promo?.code ?? "",
      promo_discount_cents: String(discountCents),
    };

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
              amount: shippingAmount,
              currency: "cad",
            },
            display_name:
              shippingAmount === 0
                ? "Free shipping"
                : "Shipping & handling",
          },
        },
      ],
      customer_creation: "always",
      billing_address_collection: "auto",
      phone_number_collection: {
        enabled: false,
      },
      metadata,
      payment_intent_data: {
        metadata,
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
