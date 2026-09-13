import test from "node:test";
import assert from "node:assert/strict";
import { APP_TIERS, capabilitiesFor, resolveCapabilities } from "../api/_lib/app-capabilities.js";

test("free accounts receive three saves and ad eligibility", () => {
  assert.deepEqual(capabilitiesFor(APP_TIERS.FREE), {
    tier: APP_TIERS.FREE,
    maxSavedDrawings: 3,
    showAds: true,
    checkoutEligible: true,
  });
});

test("annual full accounts receive unlimited saves without ads", () => {
  assert.deepEqual(capabilitiesFor(APP_TIERS.ANNUAL_FULL), {
    tier: APP_TIERS.ANNUAL_FULL,
    maxSavedDrawings: null,
    showAds: false,
    checkoutEligible: false,
  });
});

test("unknown tiers fail closed to free capabilities", () => {
  assert.deepEqual(capabilitiesFor("future-tier"), capabilitiesFor(APP_TIERS.FREE));
});

test("complimentary lifetime accounts receive administrator access without an expiry", () => {
  assert.deepEqual(
    resolveCapabilities({ tier: APP_TIERS.ANNUAL_FULL, status: "complimentary_lifetime", paid_through: null }),
    {
      tier: APP_TIERS.ANNUAL_FULL,
      paidThrough: null,
      capabilities: {
        tier: APP_TIERS.ANNUAL_FULL,
        maxSavedDrawings: null,
        showAds: false,
        checkoutEligible: false,
        administrator: true,
      },
    },
  );
});

test("suspension overrides complimentary administrator access", () => {
  const result = resolveCapabilities(
    { tier: APP_TIERS.ANNUAL_FULL, status: "complimentary_lifetime", paid_through: null },
    { suspended: true },
  );
  assert.equal(result.tier, APP_TIERS.FREE);
  assert.equal(result.capabilities.administrator, false);
});
