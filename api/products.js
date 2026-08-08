import { neon } from "@neondatabase/serverless";

const databaseUrl =
  process.env.STORAGE_DATABASE_URL_UNPOOLED;

const sql = databaseUrl ? neon(databaseUrl) : null;

const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://pipepilotapp.com",
  "https://www.pipepilotapp.com",
];

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };

  if (origin && DEFAULT_ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

export function OPTIONS(request) {
  const origin = request.headers.get("origin");

  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

export async function GET(request) {
  const origin = request.headers.get("origin");

  if (!databaseUrl || !sql) {
    console.error(
      "STORAGE_DATABASE_URL_UNPOOLED is not configured."
    );

    return Response.json(
      { error: "Database is not configured." },
      {
        status: 500,
        headers: corsHeaders(origin),
      }
    );
  }

  try {
    const rows = await sql`
      SELECT
        sku,
        name,
        price_cents,
        current_stock,
        lifetime_sold,
        active
      FROM products
      WHERE active = TRUE
      ORDER BY sku
    `;

    const products = rows.map((row) => ({
      sku: row.sku,
      name: row.name,
      price: Number(row.price_cents) / 100,
      currency: "CAD",
      stock: Number(row.current_stock),
      sold: Number(row.lifetime_sold),
      status: row.active ? "active" : "inactive",
    }));

    return Response.json(products, {
      status: 200,
      headers: corsHeaders(origin),
    });
  } catch (error) {
    console.error("Products API error:", error);

    return Response.json(
      { error: "Unable to load products." },
      {
        status: 500,
        headers: corsHeaders(origin),
      }
    );
  }
}
