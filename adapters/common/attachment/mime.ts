/**
 * Filename ↔ MIME helpers shared by IM adapters.
 *
 * Platforms differ in what they tell us about an attachment: WeCom hands back
 * only a download URL, QQ sends a `content_type`, Slack sends a `mimetype` and
 * a filename. The pieces that must agree — the extension we stage the file
 * under and the MIME we forward to the server — are derived here so the three
 * adapters cannot drift apart.
 */

const EXTENSION_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
}

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
}

/** Best-effort MIME from a filename. Returns undefined when unknown. */
export function inferMimeFromFileName(fileName?: string | null): string | undefined {
  const extension = fileName?.split('.').pop()?.toLowerCase()
  if (!extension || extension === fileName?.toLowerCase()) return undefined
  return EXTENSION_TO_MIME[extension]
}

/** File extension for an image MIME, without the dot. Defaults to `png`. */
export function imageExtensionForMime(mime?: string | null): string {
  if (!mime) return 'png'
  return MIME_TO_EXTENSION[mime.split(';')[0]!.trim().toLowerCase()] ?? 'png'
}

/** `image` when the MIME is an image type, otherwise `file`. */
export function attachmentKindForMime(mime?: string | null): 'image' | 'file' {
  return mime?.toLowerCase().startsWith('image/') ? 'image' : 'file'
}
