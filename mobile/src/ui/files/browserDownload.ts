/** In the browser hand the downloaded file to the system to save: iOS Safari 13+ and Android browsers both honor the download attribute. */
export function saveInBrowser(bytes: Uint8Array, name: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Release after the download starts; releasing immediately makes some browsers miss the content.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
