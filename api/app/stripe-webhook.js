import Stripe from "stripe";
import { neon } from "@neondatabase/serverless";
import { appBillingConfiguration, paidInvoiceCoverage, subscriptionEntitlement } from "../_lib/app-billing.js";

const databaseUrl = process.env.STORAGE_DATABASE_URL_UNPOOLED;
const sql = databaseUrl ? neon(databaseUrl) : null;

async function accountForCustomer(customerId) {
  const rows = await sql`SELECT id FROM app_accounts WHERE stripe_customer_id = ${customerId} LIMIT 1`;
  return rows[0] ?? null;
}

async function saveCoverage(accountId, coverage) {
  await sql`
    INSERT INTO app_entitlements (
      account_id, tier, status, stripe_product_id, stripe_price_id,
      stripe_subscription_id, paid_through, cancel_at_period_end, synchronized_at
    ) VALUES (
      ${accountId}, ${coverage.tier}, ${coverage.status}, ${coverage.productId},
      ${coverage.priceId}, ${coverage.subscriptionId}, ${coverage.paidThrough},
      ${coverage.cancelAtPeriodEnd}, NOW()
    )
    ON CONFLICT (account_id) DO UPDATE SET
      tier = EXCLUDED.tier,
      status = EXCLUDED.status,
      stripe_product_id = EXCLUDED.stripe_product_id,
      stripe_price_id = EXCLUDED.stripe_price_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      paid_through = GREATEST(
        COALESCE(app_entitlements.paid_through, EXCLUDED.paid_through),
        EXCLUDED.paid_through
      ),
      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
      synchronized_at = NOW(),
      updated_at = NOW()
  `;
}

async function saveSubscriptionState(accountId, state) {
  await sql`
    INSERT INTO app_entitlements (
      account_id, tier, status, stripe_product_id, stripe_price_id,
      stripe_subscription_id, cancel_at_period_end, synchronized_at
    ) VALUES (
      ${accountId}, 'free', ${state.status}, ${state.productId}, ${state.priceId},
      ${state.subscriptionId}, ${state.cancelAtPeriodEnd}, NOW()
    )
    ON CONFLICT (account_id) DO UPDATE SET
      status = EXCLUDED.status,
      stripe_product_id = EXCLUDED.stripe_product_id,
      stripe_price_id = EXCLUDED.stripe_price_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
      synchronized_at = NOW(),
      updated_at = NOW()
  `;
}

export async function POST(request) {
  if (!sql || !process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_APP_WEBHOOK_SECRET) {
    return Response.json({ error: "App webhook is unavailable." }, { status: 503 });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "Missing Stripe signature." }, { status: 400 });
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(await request.text(), signature, process.env.STRIPE_APP_WEBHOOK_SECRET);
  } catch (error) {
    console.warn("App webhook signature rejected:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Invalid webhook signature." }, { status: 400 });
  }

  try {
    const existing = await sql`
      INSERT INTO stripe_app_events (event_id, event_type)
      VALUES (${event.id}, ${event.type})
      ON CONFLICT (event_id) DO UPDATE SET event_type = EXCLUDED.event_type
      RETURNING processed_at
    `;
    if (existing[0]?.processed_at) return Response.json({ received: true, duplicate: true });

    const configuration = appBillingConfiguration();
    let result = "ignored";
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const subscriptionId = typeof invoice.subscription === "string"
        ? invoice.subscription
        : invoice.parent?.subscription_details?.subscription;
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price.product"] });
        const coverage = paidInvoiceCoverage(invoice, subscription, configuration);
        const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
        const account = customerId ? await accountForCustomer(customerId) : null;
        if (coverage && account) {
          await saveCoverage(account.id, coverage);
          result = "paid_coverage_updated";
        }
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const supplied = event.data.object;
      const subscription = await stripe.subscriptions.retrieve(supplied.id, { expand: ["items.data.price.product"] });
      const state = subscriptionEntitlement(subscription, configuration);
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
      const account = customerId ? await accountForCustomer(customerId) : null;
      if (state && account) {
        await saveSubscriptionState(account.id, state);
        result = "subscription_state_updated";
      }
    }
    await sql`UPDATE stripe_app_events SET processed_at = NOW(), result = ${result} WHERE event_id = ${event.id}`;
    return Response.json({ received: true, eventId: event.id });
  } catch (error) {
    console.error("App webhook processing failed:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
