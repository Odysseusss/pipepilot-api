import { neon } from "@neondatabase/serverless";
import { requireVerifiedAccount } from "../_lib/app-auth.js";
import { APP_TIERS, capabilitiesFor } from "../_lib/app-capabilities.js";
import { appCorsHeaders, appJson, requireAllowedAppOrigin } from "../_lib/app-http.js";

const databaseUrl = process.env.STORAGE_DATABASE_URL_UNPOOLED;
const sql = databaseUrl ? neon(databaseUrl) : null;

export function OPTIONS(request) {
  const { origin, allowed } = requireAllowedAppOrigin(request);
  if (!allowed) return appJson({ error: "Origin not allowed." }, 403, origin);
  return new Response(null, { status: 204, headers: appCorsHeaders(origin) });
}

export async function GET(request) {
  const { origin, allowed } = requireAllowedAppOrigin(request);
  if (!allowed) return appJson({ error: "Origin not allowed." }, 403, origin);
  if (!sql) {
    console.error("STORAGE_DATABASE_URL_UNPOOLED is not configured.");
    return appJson({ error: "Account service is unavailable." }, 503, origin);
  }

  const identity = await requireVerifiedAccount(request);
  if (!identity.ok) return appJson({ error: identity.error }, identity.status, origin);

  try {
    const accountRows = await sql`
      INSERT INTO app_accounts (auth_subject, normalized_email)
      VALUES (${identity.subject}, ${identity.email})
      ON CONFLICT (auth_subject) DO UPDATE
      SET normalized_email = EXCLUDED.normalized_email, updated_at = NOW()
      RETURNING id, normalized_email, suspended_at
    `;
    const account = accountRows[0];
    const entitlementRows = await sql`
      SELECT tier, status, paid_through, cancel_at_period_end
      FROM app_entitlements
      WHERE account_id = ${account.id}
      LIMIT 1
    `;
    const entitlement = entitlementRows[0] ?? null;
    const paidThrough = entitlement?.paid_through
      ? new Date(entitlement.paid_through).toISOString()
      : null;
    const paidIsCurrent =
      entitlement?.tier === APP_TIERS.ANNUAL_FULL &&
      entitlement?.status === "active" &&
      paidThrough !== null &&
      Date.parse(paidThrough) > Date.now();
    const tier = paidIsCurrent ? APP_TIERS.ANNUAL_FULL : APP_TIERS.FREE;

    return appJson({
      account: {
        id: String(account.id),
        email: account.normalized_email,
        suspended: account.suspended_at !== null,
      },
      entitlement: {
        tier,
        status: entitlement?.status ?? "free",
        paidThrough,
        cancelAtPeriodEnd: Boolean(entitlement?.cancel_at_period_end),
      },
      capabilities: capabilitiesFor(tier),
    }, 200, origin);
  } catch (error) {
    console.error("App account lookup failed:", error instanceof Error ? error.message : error);
    return appJson({ error: "Unable to load account access." }, 500, origin);
  }
}
