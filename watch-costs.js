// Supadata published rates, checked 2026-10-26: https://supadata.ai/pricing
export const CREDIT_RATES = {
  basic: { label: 'Basic / Pro recharge ($10 / 1,000 credits)', usd: 0.01 },
  mega: { label: 'Mega recharge ($10 / 5,000 credits)', usd: 0.002 },
  giga: { label: 'Giga / Supa recharge ($20 / 20,000 credits)', usd: 0.001 },
  proIncluded: { label: 'Pro included credits ($17 / 3,000; fully used)', usd: 17 / 3000 },
  free: { label: 'Free included credits (within 100/month)', usd: 0 },
};
export function forecastWatch(minutes, price, creditRate, wordsPerMinute = 120) {
  const words = Math.max(0, minutes) * wordsPerMinute;
  // Includes repeated prompts, Arabic text, sentence translations, vowel marks,
  // glosses, POS and lemmas. Token counts are assumptions, not measured usage.
  const input = words * 8, output = words * 40;
  const english = price ? (input * price.in + output * price.out) / 1e6 : null;
  const captions = creditRate, speechCredits = Math.ceil(Math.max(0, minutes)) * 2;
  return { english, low: english == null ? null : english * 0.6, high: english == null ? null : english * 1.6,
    captions, speech: speechCredits * creditRate, speechCredits };
}
export const usd = amount => amount == null ? 'Unavailable' : `$${amount.toFixed(4)}`;
