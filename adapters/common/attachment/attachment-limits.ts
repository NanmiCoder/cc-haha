/**
 * Size and MIME restrictions for IM attachments.
 *
 * Limits chosen to sit safely under both Feishu (10 MB image / 30 MB file)
 * and Telegram Bot API (10 MB image / 50 MB file), and under Claude API's
 * own image size bounds.
 */

import { t } from '../i18n.js'

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
        hint: t('attachment.tooLargeImage', { size: formatMb(size), limit: 10 }),
      }
    }
    if (mime && !IMAGE_MIME_WHITELIST.includes(mime as (typeof IMAGE_MIME_WHITELIST)[number])) {
      return {
        ok: false,
        reason: 'unsupported_mime',
        hint: t('attachment.unsupportedImage', { mime }),
      }
    }
    return { ok: true }
  }
  // kind === 'file'
  if (size > FILE_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      hint: t('attachment.fileTooLarge', { size: formatMb(size), limit: 30 }),
    }
  }
  return { ok: true }
}
