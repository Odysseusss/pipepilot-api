import test from "node:test";
import assert from "node:assert/strict";
import { appBillingConfiguration, assertAnnualPrice, paidInvoiceCoverage, safeReturnOrigin, subscriptionEntitlement } from "../api/_lib/app-billing.js";

const config = { priceId: "price_test", productId: "prod_test", expectedCurrency: "cad", expectedAmount: 1499 };
const price = { id: "price_test", product: "prod_test", active: true, currency: "cad", unit_amount: 1499, type: "recurring", recurring: { interval: "year", interval_count: 1 } };

test("billing configuration requires an explicit currency and Stripe allowlist", () => {
  assert.throws(() => appBillingConfiguration({ STRIPE_APP_ANNUAL_PRICE_ID: "price_test" }));
  assert.deepEqual(appBillingConfiguration({ STRIPE_APP_ANNUAL_PRICE_ID: "price_test", STRIPE_APP_PRODUCT_ID: "prod_test", STRIPE_APP_CURRENCY: "CAD" }), config);
});

test("annual price must match every server policy field", () => {
  assert.doesNotThrow(() => assertAnnualPrice(price, config));
  assert.throws(() => assertAnnualPrice({ ...price, unit_amount: 1500 }, config));
  assert.throws(() => assertAnnualPrice({ ...price, recurring: { interval: "month", interval_count: 1 } }, config));
});

test("subscription entitlement uses the matching item period", () => {
  const result = subscriptionEntitlement({ id: "sub_test", status: "active", cancel_at_period_end: true, items: { data: [{ price, current_period_end: 2000000000 }] } }, config);
  assert.equal(result.tier, "annual_full");
  assert.equal(result.cancelAtPeriodEnd, true);
  assert.equal(result.paidThrough.toISOString(), "2033-05-18T03:33:20.000Z");
});

test("unrecognized price cannot grant access", () => {
  assert.equal(subscriptionEntitlement({ id: "sub_bad", status: "active", items: { data: [{ price: { ...price, id: "price_other" }, current_period_end: 2000000000 }] } }, config), null);
});

test("only a paid invoice establishes a new coverage end", () => {
  const subscription = { id: "sub_test", customer: "cus_test", status: "active", cancel_at_period_end: false, items: { data: [{ price, current_period_end: 2100000000 }] } };
  const invoice = { status: "paid", lines: { data: [{ price, period: { end: 2000000000 } }] } };
  assert.equal(paidInvoiceCoverage(invoice, subscription, config).paidThrough.toISOString(), "2033-05-18T03:33:20.000Z");
  assert.equal(paidInvoiceCoverage({ ...invoice, status: "open" }, subscription, config), null);
});

test("return origins must come from the server allowlist", () => {
  assert.equal(safeReturnOrigin("http://localhost:56069", ["http://localhost:56069"]), "http://localhost:56069");
  assert.throws(() => safeReturnOrigin("https://evil.example", ["http://localhost:56069"]));
});
