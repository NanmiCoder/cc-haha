/**
 * Anthropic API Limits
 *
 * These constants define server-side limits enforced by the Anthropic API.
 * Keep this file dependency-free to prevent circular imports.
 *
 * Last verified: 2026-06-01
 * Source: Claude Vision API docs and api/api/config.py
 *
 * Future: See issue #13240 for dynamic limits fetching from server.
 */

// =============================================================================
// IMAGE LIMITS
// =============================================================================

/**
 * Maximum base64-encoded image size (API enforced).
 * The API rejects images where the base64 string length exceeds this value.
 * Note: This is the base64 length, NOT raw bytes. Base64 increases size by ~33%.
 */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024 // 5 MB

/**
 * Target raw image size to stay under base64 limit after encoding.
 * Base64 encoding increases size by 4/3, so we derive the max raw size:
 * raw_size * 4/3 = base64_size → raw_size = base64_size * 3/4
 */
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4 // 3.75 MB

/**
 * API-enforced maximum dimensions for image inputs.
 *
 * Note: The API internally resizes images whose long edge is larger than
 * 1568px, but that is handled server-side and doesn't cause errors. Keep this
 * limit aligned with the API's rejection threshold so common tall screenshots
 * are not locally resized or rejected just because they exceed 2000px.
 *
 * The API_IMAGE_MAX_BASE64_SIZE (5MB) is the actual hard limit that causes
 * API errors for ordinary screenshots before dimensions usually matter.
 */
export const IMAGE_MAX_WIDTH = 8000
export const IMAGE_MAX_HEIGHT = 8000

// =============================================================================
// PDF LIMITS
// =============================================================================

/**
 * Maximum raw PDF file size that fits within the API request limit after encoding.
 * The API has a 32MB total request size limit. Base64 encoding increases size by
 * ~33% (4/3), so 20MB raw → ~27MB base64, leaving room for conversation context.
 */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024 // 20 MB

/**
 * Maximum number of pages in a PDF accepted by the API.
 */
export const API_PDF_MAX_PAGES = 100

/**
 * Size threshold above which PDFs are extracted into page images
 * instead of being sent as base64 document blocks. This applies to
 * first-party API only; non-first-party always uses extraction.
 */
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024 // 3 MB

/**
 * Maximum PDF file size for the page extraction path. PDFs larger than
 * this are rejected to avoid processing extremely large files.
 */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024 // 100 MB

/**
 * Max pages the Read tool will extract in a single call with the pages parameter.
 */
export const PDF_MAX_PAGES_PER_READ = 20

/**
 * PDFs with more pages than this get the reference treatment on @ mention
 * instead of being inlined into context.
 */
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10

// =============================================================================
// MEDIA LIMITS
// =============================================================================

/**
 * Maximum number of media items (images + PDFs) allowed per API request.
 * The API rejects requests exceeding this limit with a confusing error.
 * We validate client-side to provide a clear error message.
 */
export const API_MAX_MEDIA_PER_REQUEST = 100

/**
 * Maximum total base64-encoded media size budget per API request (bytes).
 *
 * The API has a ~20 MB total request size limit. Conversations accumulate
 * base64 images (from the Read tool viewing local files and from image-gen
 * plugin results) that never get evicted by toolResultStorage because
 * hasImageBlock() skips both persistence and budget eviction for image blocks.
 *
 * We enforce a 12 MB media budget to leave headroom for the rest of the
 * conversation context (system prompt, text messages, tool definitions).
 * When over budget, the oldest media blocks are replaced with text placeholders.
 */
export const API_MAX_MEDIA_BYTES_BUDGET = 12 * 1024 * 1024 // 12 MB
