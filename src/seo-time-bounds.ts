// Shared by server stages and the enclosing runner RPC; all are clipped to
// the original deadline. No retries or extra calls are funded by these waits.
export const SEO_LONG_TEXT_MS = 480_000;
export const SEO_HOSTED_RESPONSE_MS = 120_000;
export const SEO_SOURCE_RECOVERY_MS = 10_000;
export const SEO_RESEARCH_OVERHEAD_MS = 80_000;
export const SEO_RESEARCH_RPC_MS =
  SEO_LONG_TEXT_MS +
  2 * SEO_HOSTED_RESPONSE_MS +
  SEO_SOURCE_RECOVERY_MS +
  SEO_RESEARCH_OVERHEAD_MS;
