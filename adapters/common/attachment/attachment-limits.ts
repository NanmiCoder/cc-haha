/**
 * Size and MIME restrictions for IM attachments.
 *
 * Limits chosen to sit safely under both Feishu (10 MB image / 30 MB file)
 * and Telegram Bot API (10 MB image / 50 MB file), and under Claude API's
 * own image size bounds.
 */

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
export const FILE_MAX_BYTES = 30 * 1024 * 1024  // 30 MB

export const IMAGE_MIME_WHITELIST = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const

export type LimitCheckResult =
  | { ok: true }
  | { ok: false; reason: 'too_large' | 'unsupported_mime'; hint: string }

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

export function checkAttachmentLimit(
  kind: 'image' | 'file',
  size: number,
  mime?: string,
): LimitCheckResult {
  if (kind === 'image') {
    if (size > IMAGE_MAX_BYTES) {
      return {
        ok: false,
        reason: 'too_large',
        hint: `📎 Image too large (${formatMb(size)} MB); keep it under 10 MB`,
      }
    }
    if (mime && !IMAGE_MIME_WHITELIST.includes(mime as (typeof IMAGE_MIME_WHITELIST)[number])) {
      return {
        ok: false,
        reason: 'unsupported_mime',
        hint: `📎 Unsupported image format (${mime})`,
      }
    }
    return { ok: true }
  }
  // kind === 'file'
  if (size > FILE_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      hint: `📎 File too large (${formatMb(size)} MB); keep it under 30 MB`,
    }
  }
  return { ok: true }
}
