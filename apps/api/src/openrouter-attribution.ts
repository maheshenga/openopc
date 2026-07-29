// Canonical OpenRouter app attribution.

import { PRODUCT_BRAND } from '@kortix/product-brand';
//
// OpenRouter groups usage into a leaderboard "app" keyed on the `HTTP-Referer`
// (aka `http-referer`) header, with `X-Title` as the display name. If that
// referer is derived from a per-deployment URL, every environment registers as a
// SEPARATE app: dev trycloudflare tunnels, api-prod.kortix.com, api.kortix.com,
// kortix.ai, etc. — which is exactly the fragmentation we had (a dozen different
// separate legacy-branded apps splitting our token attribution).
//
// To keep all OpenRouter traffic under one app no matter where it runs,
// these values are HARDCODED (never env-derived) and used at every site that
// talks to OpenRouter. Pinned to the dominant existing app: https://www.kortix.com.
//
// Do not swap these for config.KORTIX_URL / config.FRONTEND_URL — that is what
// caused the split in the first place.
export const OPENROUTER_APP_REFERER = 'https://www.kortix.com';
export const OPENROUTER_APP_TITLE = PRODUCT_BRAND.displayName;
