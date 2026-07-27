// api/_models.js — Quality-tier → OpenRouter model resolution.
//
// The client sends a `tier` ("normal" | "high" | "extrahigh") instead of a
// concrete model id. The server resolves the tier to a model here, with env
// overrides so models can be swapped without a code redeploy.
//
// Env overrides (all optional; hardcoded defaults are used if unset):
//   MODEL_NORMAL=openai/gpt-4o-mini
//   MODEL_HIGH=google/gemini-flash-1.5
//   MODEL_EXTRAHIGH=openai/gpt-4o
//
// `FALLBACK_TIER` is used when the client sends a missing/unknown tier, and is
// also the retry model when the primary model returns a 5xx/rate-limit from
// OpenRouter.

export const TIER_TO_MODEL = {
  normal:    process.env.MODEL_NORMAL    || "openai/gpt-4o-mini",
  high:      process.env.MODEL_HIGH      || "google/gemini-flash-1.5",
  extrahigh: process.env.MODEL_EXTRAHIGH || "openai/gpt-4o",
};

export const FALLBACK_TIER = "normal";

export const VALID_TIERS = new Set(["normal", "high", "extrahigh"]);

// Resolve a tier string to a concrete model id. Falls back to the `normal`
// tier model if the tier is missing/invalid.
export function resolveModel(tier) {
  if (!tier || !VALID_TIERS.has(tier)) return TIER_TO_MODEL[FALLBACK_TIER];
  return TIER_TO_MODEL[tier];
}