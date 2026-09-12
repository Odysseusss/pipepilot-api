import { neon } from "@neondatabase/serverless";
import { requireVerifiedAccount } from "../_lib/app-auth.js";
import { appCorsHeaders, appJson, requireAllowedAppOrigin } from "../_lib/app-http.js";
import { upsertAppAccount } from "../_lib/app-account-store.js";

const databaseUrl = process.env.STORAGE_DATABASE_URL_UNPOOLED;
const sql = databaseUrl ? neon(databaseUrl) : null;

export function OPTIONS(request) {
  const { origin, allowed } = requireAllowedAppOrigin(request);
  if (!allowed) return appJson({ error: "Origin not allowed." }, 403, origin);
  return new Response(null, { status: 204, headers: appCorsHeaders(origin) });
}

async function mailerLiteRequest(path, options = {}) {
  const apiKey = process.env.MAILERLITE_API_KEY;
  if (!apiKey) throw new Error("MailerLite is not configured.");
  const response = await fetch(`https://connect.mailerlite.com/api${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`MailerLite returned ${response.status}.`);
  return response.status === 204 ? null : response.json();
}

export async function POST(request) {
  const { origin, allowed } = requireAllowedAppOrigin(request);
  if (!allowed) return appJson({ error: "Origin not allowed." }, 403, origin);
  if (!sql) return appJson({ error: "Account service is unavailable." }, 503, origin);
  const identity = await requireVerifiedAccount(request);
  if (!identity.ok) return appJson({ error: identity.error }, identity.status, origin);

  try {
    const payload = await request.json();
    if (typeof payload?.consent !== "boolean") {
      return appJson({ error: "Marketing consent must be true or false." }, 400, origin);
    }
    const groupId = process.env.MAILERLITE_APP_GROUP_ID?.trim();
    if (!groupId) throw new Error("MailerLite group is not configured.");
    const account = await upsertAppAccount(sql, identity);
    let subscriberId = account.mailerlite_subscriber_id;
    if (payload.consent) {
      const result = await mailerLiteRequest("/subscribers", {
        method: "POST",
        body: JSON.stringify({ email: identity.email, groups: [groupId] }),
      });
      subscriberId = String(result?.data?.id ?? "");
      if (!subscriberId) throw new Error("MailerLite did not return a subscriber.");
    } else if (subscriberId) {
      await mailerLiteRequest(`/subscribers/${encodeURIComponent(subscriberId)}/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
    }
    await sql`
      UPDATE app_accounts
      SET marketing_consent = ${payload.consent},
          mailerlite_subscriber_id = ${subscriberId || null},
          updated_at = NOW()
      WHERE id = ${account.id}
    `;
    await sql`
      INSERT INTO account_audit_events (account_id, event_type, details)
      VALUES (${account.id}, 'marketing_preference_changed', ${JSON.stringify({ consent: payload.consent })}::jsonb)
    `;
    return appJson({ marketingConsent: payload.consent }, 200, origin);
  } catch (error) {
    console.error("Marketing preference update failed:", error instanceof Error ? error.message : error);
    return appJson({ error: "Unable to update newsletter preference." }, 502, origin);
  }
}
