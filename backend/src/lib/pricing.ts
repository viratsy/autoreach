/**
 * WhatsApp Business API pricing (India, per conversation).
 * Prices in INR. Updated as of 2026.
 * Source: Meta pricing page
 */
export const PRICING_INR = {
  utility: 0.115,
  marketing: 0.8631,
  authentication: 0.115,
  service: 0.00,
};

export function estimateCost(
  totalContacts: number,
  category: string
): { perMessage: number; total: number; currency: string } {
  const cat = category.toLowerCase() as keyof typeof PRICING_INR;
  // `?? ` not `||` — service is legitimately priced at 0, which `||` would treat as
  // falsy and silently replace with the utility rate.
  const perMessage = PRICING_INR[cat] ?? PRICING_INR.utility;
  return {
    perMessage,
    total: Math.round(totalContacts * perMessage * 100) / 100,
    currency: "INR",
  };
}

export function calculateActualCost(
  deliveredCount: number,
  category: string
): { perMessage: number; total: number; currency: string } {
  const cat = category.toLowerCase() as keyof typeof PRICING_INR;
  // `?? ` not `||` — service is legitimately priced at 0, which `||` would treat as
  // falsy and silently replace with the utility rate.
  const perMessage = PRICING_INR[cat] ?? PRICING_INR.utility;
  return {
    perMessage,
    total: Math.round(deliveredCount * perMessage * 100) / 100,
    currency: "INR",
  };
}
