/**
 * Brand colors for file-type icons, keyed by `describeFileType().icon`.
 *
 * These are identity colors (PDF red, Word blue, ...) that must read the same in
 * every theme, and react-file-icon writes them into SVG attributes where CSS
 * variables are not reliable, so they live here rather than in theme tokens.
 */
export const FILE_GROUP_COLORS: Record<string, string> = {
  picture_as_pdf: '#D93831',
  docs: '#2C5898',
  markdown: '#3B6FE0',
  text_snippet: '#667085',
  table_chart: '#1A754C',
  slideshow: '#D14423',
  folder_zip: '#B7791F',
  audio_file: '#AD477C',
  video_file: '#6655B8',
  html: '#C05D2C',
  image: '#24899A',
  code: '#7656B5',
  insert_drive_file: '#667085',
}

/** Darken a #rrggbb color by `amount` (0-1), used for the folded corner. */
export function shadeHex(hex: string, amount: number): string {
  const channel = (offset: number) => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * (1 - amount)).toString(16).padStart(2, '0')
  return `#${channel(1)}${channel(3)}${channel(5)}`
}
