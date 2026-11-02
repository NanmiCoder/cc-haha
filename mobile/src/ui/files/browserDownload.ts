/** 浏览器里把下载好的文件交给系统保存：iOS Safari 13+ 与安卓浏览器都认 download 属性。 */
export function saveInBrowser(bytes: Uint8Array, name: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 下载开始后再释放；立刻释放会让部分浏览器拿不到内容。
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
