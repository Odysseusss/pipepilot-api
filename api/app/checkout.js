import Stripe from "stripe";
import { neon } from "@neondatabase/serverless";
import { requireVerifiedAccount } from "../_lib/app-auth.js";
import { allowedAppOrigins, appCorsHeaders, appJson, requireAllowedAppOrigin } from "../_lib/app-http.js";
import { currentAppEntitlement, upsertAppAccount } from "../_lib/app-account-store.js";
import { APP_BILLING_SOURCE, appBillingConfiguration, assertAnnualPrice, safeReturnOrigin } from "../_lib/app-billing.js";

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
    const configuration = appBillingConfiguration();
    const stripe = new Stripe(process.env.STRIPE_APP_SECRET_KEY);
    const price = await stripe.prices.retrieve(configuration.priceId);
    assertAnnualPrice(price, configuration);
    const account = await upsertAppAccount(sql, identity);
    if (account.suspended_at) return appJson({ error: "Account access is suspended." }, 403, origin);
    const entitlement = await currentAppEntitlement(sql, account.id);
    if (entitlement?.paid_through && Date.parse(entitlement.paid_through) > Date.now()) {
      return appJson({ error: "This account already has paid access." }, 409, origin);
    }

    let customerId = account.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: identity.email,
        metadata: { source: APP_BILLING_SOURCE, account_id: String(account.id), auth_subject: identity.subject },
      });
      customerId = customer.id;
      await sql`UPDATE app_accounts SET stripe_customer_id = ${customerId}, updated_at = NOW() WHERE id = ${account.id} AND stripe_customer_id IS NULL`;
    }
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 20,
    });
    const alreadySubscribed = subscriptions.data.some((subscription) => {
      if (!["active", "trialing", "past_due", "unpaid"].includes(subscription.status)) return false;
      return subscription.items.data.some((item) => {
        const productId = typeof item.price.product === "string"
          ? item.price.product
          : item.price.product?.id;
        return item.price.id === configuration.priceId && productId === configuration.productId;
      });
    });
    if (alreadySubscribed) {
      return appJson({ error: "This account already has an annual subscription." }, 409, origin);
    }
    const returnOrigin = safeReturnOrigin(origin, allowedAppOrigins());
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: configuration.priceId, quantity: 1 }],
      allow_promotion_codes: false,
      client_reference_id: String(account.id),
      metadata: { source: APP_BILLING_SOURCE, account_id: String(account.id) },
      subscription_data: { metadata: { source: APP_BILLING_SOURCE, account_id: String(account.id) } },
      custom_text: {
        submit: {
          message: "CAD $14.99 per year. Renews automatically until cancelled. Cancel before renewal in billing settings. Free access is available to confirm Pipe Pilot fits your needs before purchase. Payments are non-refundable except where required by law.",
        },
      },
      success_url: `${returnOrigin}/?billing=return`,
      cancel_url: `${returnOrigin}/?billing=cancelled`,
    });
    if (!session.url) throw new Error("Stripe did not return a Checkout URL.");
    return appJson({ url: session.url }, 200, origin);
  } catch (error) {
    console.error("App checkout failed:", error instanceof Error ? error.message : error);
    return appJson({ error: "Unable to start annual checkout." }, 400, origin);
  }
}
