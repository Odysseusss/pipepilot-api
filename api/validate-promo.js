import { neon } from "@neondatabase/serverless";

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

async function priceCart(rawItems) {
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
  let subtotalCents = 0;

  for (const item of requested) {
    const product = catalog.get(item.sku);

    if (!product) {
      throw new Error(`Unknown or inactive product: ${item.sku}.`);
    }

    if (item.quantity > Number(product.current_stock)) {
      throw new Error(`${product.name} does not have enough stock available.`);
    }

    subtotalCents += Number(product.price_cents) * item.quantity;
  }

  return { requested, subtotalCents };
}

function promoIsExpired(expiresAt) {
  return expiresAt && new Date(expiresAt).getTime() <= Date.now();
}

function evaluatePromo(promo, subtotalCents) {
  if (!promo || !promo.active) {
    throw new Error("Promo code is not valid.");
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
    const minimum = Number(promo.minimum_subtotal_cents ?? 0) / 100;
    throw new Error(`This promo requires at least $${minimum.toFixed(2)} in merchandise.`);
  }

  const type = String(promo.discount_type).toLowerCase();
  const value = Number(promo.discount_value ?? 0);

  if (type === "percent") {
    if (!Number.isFinite(value) || value <= 0 || value >= 100) {
      throw new Error("Promo percentage is not configured correctly.");
    }

    const discountCents = Math.round(subtotalCents * (value / 100));

    return {
      discountCents,
      freeShipping: false,
      message: `${value}% off applied.`,
    };
  }

  if (type === "free_shipping") {
    return {
      discountCents: 0,
      freeShipping: true,
      message: "Free shipping applied.",
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
    return jsonResponse({ valid: false, error: "Origin not allowed." }, 403, origin);
  }

  if (!databaseUrl || !sql) {
    console.error("STORAGE_DATABASE_URL_UNPOOLED is not configured.");
    return jsonResponse({ valid: false, error: "Promo validation is temporarily unavailable." }, 500, origin);
  }

  try {
    const payload = await request.json();
    const code = String(payload?.code ?? "").trim().toUpperCase();

    if (!code) {
      throw new Error("Enter a promo code first.");
    }

    const { subtotalCents } = await priceCart(payload?.items);

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

    const result = evaluatePromo(rows[0], subtotalCents);
    const discountedSubtotalCents = Math.max(0, subtotalCents - result.discountCents);
    const shippingCents =
      result.freeShipping || discountedSubtotalCents >= FREE_SHIPPING_THRESHOLD
        ? 0
        : SHIPPING_AMOUNT;

    return jsonResponse(
      {
        valid: true,
        code,
        discountCents: result.discountCents,
        freeShipping: result.freeShipping,
        message: result.message,
        subtotalCents,
        discountedSubtotalCents,
        shippingCents,
        totalCents: discountedSubtotalCents + shippingCents,
      },
      200,
      origin
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Promo code could not be validated.";
    return jsonResponse({ valid: false, error: message }, 400, origin);
  }
}
