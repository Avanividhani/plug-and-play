/**
 * Built-in AI keys used when env / userData are empty.
 * Used for packaged builds when environment variables are empty.
 * Vite inlines these into dist-electron/main.js for installers.
 */

/** Prefer for Pollinations video (enter.pollinations.ai). */
export const BUNDLED_POLLINATIONS_SK =
  'sk_tGnpXdGX9LLk7spZbjm0NAYkpcC0TePX'

/** Fallback Pollinations key (AQ.…). Never use as Gemini. */
export const BUNDLED_POLLINATIONS_AQ =
  'AQ.Ab8RN6IjWqj_tmIp2tQxUUxMKFjs6Gy6kbfByXL2iAkLgam9vQ'

/**
 * Google AI Studio / Gemini (must start with AIza). Leave empty if unused —
 * Motion/Still then use Pollinations only.
 */
export const BUNDLED_GEMINI_KEY = ''
