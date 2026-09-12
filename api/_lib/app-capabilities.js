export const APP_TIERS = Object.freeze({
  FREE: "free",
  ANNUAL_FULL: "annual_full",
});

export function capabilitiesFor(tier) {
  if (tier === APP_TIERS.ANNUAL_FULL) {
    return {
      maxSavedDrawings: null,
      showAds: false,
      checkoutEligible: false,
    };
  }
  return {
    maxSavedDrawings: 3,
    showAds: true,
    checkoutEligible: true,
  };
}
