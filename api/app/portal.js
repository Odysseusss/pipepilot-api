import Stripe from "stripe";
import { neon } from "@neondatabase/serverless";
import { requireVerifiedAccount } from "../_lib/app-auth.js";
import { allowedAppOrigins, appCorsHeaders, appJson, requireAllowedAppOrigin } from "../_lib/app-http.js";
import { upsertAppAccount } from "../_lib/app-account-store.js";
import { safeReturnOrigin } from "../_lib/app-billing.js";

const databaseUrl = process.env.STORAGE_DATABASE_URL_UNPOOLED;
const sql = databaseUrl ? neon(databaseUrl) : null;

export function OPTIONS(request) {
  const { origin, allowed } = requireAllowedAppOrigin(request);
  if (!allowed) return appJson({ error: "Origin not allowed." }, 403, origin);
  return new Response(null, { status: 204, headers: appCorsHeaders(origin) });
}

export async function POST(request) {
  const { origin, allowed } = requireAllowedAppOrigin(request);
  if (!allowed) return appJson({ error: "Origin not allowed." }, 403, origin);
  if (!sql || !process.env.STRIPE_APP_SECRET_KEY) return appJson({ error: "Billing is unavailable." }, 503, origin);
  const identity = await requireVerifiedAccount(request);
  if (!identity.ok) return appJson({ error: identity.error }, identity.status, origin);
  try {
    const account = await upsertAppAccount(sql, identity);
    if (!account.stripe_customer_id) return appJson({ error: "No billing account exists yet." }, 404, origin);
    const session = await new Stripe(process.env.STRIPE_APP_SECRET_KEY).billingPortal.sessions.create({
      customer: account.stripe_customer_id,
      return_url: `${safeReturnOrigin(origin, allowedAppOrigins())}/`,
    });
    return appJson({ url: session.url }, 200, origin);
  } catch (error) {
    console.error("App billing portal failed:", error instanceof Error ? error.message : error);
    return appJson({ error: "Unable to open billing management." }, 400, origin);
  }
}
