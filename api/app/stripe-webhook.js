import Stripe from "stripe";
import { neon } from "@neondatabase/serverless";
import { appBillingConfiguration, paidInvoiceCoverage, subscriptionEntitlement } from "../_lib/app-billing.js";

const databaseUrl = process.env.STORAGE_DATABASE_URL_UNPOOLED;
const sql = databaseUrl ? neon(databaseUrl) : null;

async function accountForCustomer(customerId) {
  const rows = await sql`SELECT id FROM app_accounts WHERE stripe_customer_id = ${customerId} LIMIT 1`;
  return rows[0] ?? null;
}

async function accountForSubscription(subscription) {
  const customerId = typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer?.id;
  const byCustomer = customerId ? await accountForCustomer(customerId) : null;
  if (byCustomer) return byCustomer;

  const accountId = Number(subscription.metadata?.account_id);
  if (!Number.isSafeInteger(accountId) || accountId < 1) return null;
  const rows = await sql`SELECT id FROM app_accounts WHERE id = ${accountId} LIMIT 1`;
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
    WHERE app_entitlements.status <> 'complimentary_lifetime'
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
    WHERE app_entitlements.status <> 'complimentary_lifetime'
  `;
}

export async function POST(request) {
  if (!sql || !process.env.STRIPE_APP_SECRET_KEY || !process.env.STRIPE_APP_WEBHOOK_SECRET) {
    return Response.json({ error: "App webhook is unavailable." }, { status: 503 });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "Missing Stripe signature." }, { status: 400 });
  const stripe = new Stripe(process.env.STRIPE_APP_SECRET_KEY);
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
      RETURNING processed_at, result
    `;
    const completedResults = new Set(["paid_coverage_updated", "subscription_state_updated"]);
    if (existing[0]?.processed_at && completedResults.has(existing[0]?.result)) {
      return Response.json({ received: true, duplicate: true });
    }

    const configuration = appBillingConfiguration();
    let result = "ignored";
    if (event.type === "invoice.paid" || event.type === "invoice_payment.paid") {
      const supplied = event.data.object;
      const suppliedInvoiceId = typeof supplied.invoice === "string" ? supplied.invoice : supplied.invoice?.id;
      const invoice = event.type === "invoice_payment.paid"
        ? suppliedInvoiceId ? await stripe.invoices.retrieve(suppliedInvoiceId) : null
        : supplied;
      if (!invoice) {
        result = "paid_invoice_not_found";
      } else {
      const subscriptionId = typeof invoice.subscription === "string"
        ? invoice.subscription
        : invoice.parent?.subscription_details?.subscription;
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price.product"] });
        const coverage = paidInvoiceCoverage(invoice, subscription, configuration);
        const account = await accountForSubscription(subscription);
        if (coverage && account) {
          await saveCoverage(account.id, coverage);
          result = "paid_coverage_updated";
        } else {
          result = coverage ? "paid_account_not_found" : "paid_coverage_not_matched";
        }
      } else {
        result = "paid_subscription_not_found";
      }
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const supplied = event.data.object;
      const subscription = await stripe.subscriptions.retrieve(supplied.id, { expand: ["items.data.price.product"] });
      const state = subscriptionEntitlement(subscription, configuration);
      const account = await accountForSubscription(subscription);
      if (state && account) {
        await saveSubscriptionState(account.id, state);
        result = "subscription_state_updated";
      } else {
        result = state ? "subscription_account_not_found" : "subscription_not_matched";
      }
    }
    await sql`UPDATE stripe_app_events SET processed_at = NOW(), result = ${result} WHERE event_id = ${event.id}`;
    console.info("App webhook processed", { eventId: event.id, eventType: event.type, result });
    return Response.json({ received: true, eventId: event.id });
  } catch (error) {
    console.error("App webhook processing failed:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
