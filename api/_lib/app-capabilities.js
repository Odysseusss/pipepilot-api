export const APP_TIERS = Object.freeze({
  FREE: "free",
  ANNUAL_FULL: "annual_full",
});

export const COMPLIMENTARY_LIFETIME_STATUS = "complimentary_lifetime";

export function capabilitiesFor(tier) {
  if (tier === APP_TIERS.ANNUAL_FULL) {
    return {
      tier: APP_TIERS.ANNUAL_FULL,
      maxSavedDrawings: null,
      showAds: false,
      checkoutEligible: false,
    };
  }
  return {
    tier: APP_TIERS.FREE,
    maxSavedDrawings: 3,
    showAds: true,
    checkoutEligible: true,
  };
}

export function resolveCapabilities(entitlement, { suspended = false, now = Date.now() } = {}) {
  const administrator = entitlement?.status === COMPLIMENTARY_LIFETIME_STATUS;
  const paidThrough = entitlement?.paid_through
    ? new Date(entitlement.paid_through).toISOString()
    : null;
  const annualAccess =
    entitlement?.tier === APP_TIERS.ANNUAL_FULL &&
    !suspended &&
    (administrator || (paidThrough !== null && Date.parse(paidThrough) > now));
  const tier = annualAccess ? APP_TIERS.ANNUAL_FULL : APP_TIERS.FREE;
  return {
    tier,
    paidThrough,
    capabilities: { ...capabilitiesFor(tier), administrator: annualAccess && administrator },
  };
}
