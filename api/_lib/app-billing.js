export const APP_BILLING_SOURCE = "pipepilot-app";

export function appBillingConfiguration(env = process.env) {
  const priceId = env.STRIPE_APP_ANNUAL_PRICE_ID?.trim();
  const productId = env.STRIPE_APP_PRODUCT_ID?.trim();
  const expectedCurrency = env.STRIPE_APP_CURRENCY?.trim().toLowerCase();
  const expectedAmount = Number(env.STRIPE_APP_ANNUAL_AMOUNT ?? 1499);
  if (!priceId || !productId || !expectedCurrency) {
    throw new Error("App billing is not configured.");
  }
  if (!Number.isInteger(expectedAmount) || expectedAmount < 1) {
    throw new Error("App billing amount is invalid.");
  }
  return { priceId, productId, expectedCurrency, expectedAmount };
}

export function assertAnnualPrice(price, configuration) {
  const productId = typeof price.product === "string" ? price.product : price.product?.id;
  if (
    price.id !== configuration.priceId ||
    productId !== configuration.productId ||
    price.active !== true ||
    price.currency !== configuration.expectedCurrency ||
    price.unit_amount !== configuration.expectedAmount ||
    price.type !== "recurring" ||
    price.recurring?.interval !== "year" ||
    price.recurring?.interval_count !== 1
  ) {
    throw new Error("Configured annual price does not match Pipe Pilot billing policy.");
  }
}

export function subscriptionEntitlement(subscription, configuration) {
  const matchingItem = subscription.items?.data?.find((item) => {
    const productId = typeof item.price?.product === "string"
      ? item.price.product
      : item.price?.product?.id;
    return item.price?.id === configuration.priceId && productId === configuration.productId;
  });
  if (!matchingItem) return null;
  const paidThroughSeconds = matchingItem.current_period_end ?? subscription.current_period_end;
  if (!Number.isFinite(paidThroughSeconds)) return null;
  const status = String(subscription.status ?? "unknown");
  const paid = status === "active" || status === "trialing";
  return {
    tier: paid ? "annual_full" : "free",
    status,
    paidThrough: new Date(paidThroughSeconds * 1000),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    priceId: matchingItem.price.id,
    productId: configuration.productId,
    subscriptionId: subscription.id,
  };
}

export function paidInvoiceCoverage(invoice, subscription, configuration) {
  if (invoice.status !== "paid") return null;
  const line = invoice.lines?.data?.find((candidate) => {
    const price = candidate.pricing?.price_details?.price ?? candidate.price;
    const priceId = typeof price === "string" ? price : price?.id;
    return priceId === configuration.priceId;
  });
  if (!line?.period?.end) return null;
  const entitlement = subscriptionEntitlement(subscription, configuration);
  if (!entitlement) return null;
  return { ...entitlement, tier: "annual_full", status: subscription.status, paidThrough: new Date(line.period.end * 1000) };
}

export function safeReturnOrigin(requestOrigin, allowedOrigins) {
  if (!requestOrigin || !allowedOrigins.includes(requestOrigin)) {
    throw new Error("Return origin is not allowed.");
  }
  return requestOrigin;
}
