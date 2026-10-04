export const BUSINESS_ERROR_CODES = {
  PDF_TOO_LARGE: 'pdf_too_large',
  PDF_PASSWORD_PROTECTED: 'pdf_password_protected',
  PDF_INVALID: 'pdf_invalid',
  IMAGE_TOO_LARGE: 'image_too_large',
  IMAGE_UNSUPPORTED: 'image_unsupported',
  REQUEST_TOO_LARGE: 'request_too_large',
  PROMPT_TOO_LONG: 'prompt_too_long',
  AUTO_MODE_UNAVAILABLE: 'auto_mode_unavailable',
  UPSTREAM_STREAM_INTERRUPTED: 'upstream_stream_interrupted',
} as const

export type BusinessErrorCode =
  (typeof BUSINESS_ERROR_CODES)[keyof typeof BUSINESS_ERROR_CODES]

// Block types to strip from the single turn a rejection followed.
// REQUEST_TOO_LARGE is deliberately absent: a byte limit says nothing about
// which block was at fault, so normalizeMessagesForAPI resolves it history-wide.
export const BUSINESS_ERROR_MEDIA_BLOCK_TYPES: Partial<
  Record<BusinessErrorCode, readonly ('document' | 'image')[]>
> = {
  [BUSINESS_ERROR_CODES.PDF_TOO_LARGE]: ['document'],
  [BUSINESS_ERROR_CODES.PDF_PASSWORD_PROTECTED]: ['document'],
  [BUSINESS_ERROR_CODES.PDF_INVALID]: ['document'],
  [BUSINESS_ERROR_CODES.IMAGE_TOO_LARGE]: ['image'],
  [BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED]: ['image'],
}

/**
 * Wording of the request-too-large error before it reported measured sizes.
 * Transcripts persisted it (the oldest without a businessErrorCode), so history
 * normalization must keep recognizing both the SDK and the interactive variant.
 */
export const LEGACY_REQUEST_TOO_LARGE_ERROR_MESSAGES: readonly string[] = [
  'Request too large (max 20MB). Try with a smaller file.',
  'Request too large (max 20MB). Double press esc to go back and try with a smaller file.',
]
