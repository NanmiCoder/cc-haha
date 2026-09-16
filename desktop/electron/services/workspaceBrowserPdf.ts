import { open, unlink } from 'node:fs/promises'
import path from 'node:path'

export async function saveWorkspaceBrowserPdf(
  data: Uint8Array,
  selectPath: () => Promise<string | null>,
): Promise<string | null> {
  const savePath = await selectPath()
  if (!savePath) return null
  const { dir, name, ext } = path.parse(savePath)
  // Exclusive creation handles both preexisting user files and two exports
  // choosing the same name concurrently. Never truncate a selected path.
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? savePath : path.join(dir, `${name} (${suffix})${ext}`)
    const file = await open(candidate, 'wx').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return null
      throw error
    })
    if (!file) continue
    let written = false
    try {
      await file.writeFile(data)
      written = true
      return candidate
    } finally {
      try {
        await file.close()
      } finally {
        // Windows cannot unlink an open file; only clean up our reservation.
        if (!written) await unlink(candidate).catch(() => {})
      }
    }
  }
}
