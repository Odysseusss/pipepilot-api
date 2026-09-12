export const APP_TIERS = Object.freeze({
  FREE: "free",
  ANNUAL_FULL: "annual_full",
});

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
