import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'

type IconItem = InstanceType<typeof Data.IconItem> | InstanceType<typeof Data.RawIconItem>

function iconFingerprint(icon: IconItem): string {
  return createHash('sha256').update(Buffer.from(icon.isRaw() ? icon.bin : icon.generate())).digest('hex')
}

// Reuse electron-builder's PE resource parser. Inspect bytes from the finished
// executable, including signed builds, instead of trusting win.icon config.
export function assertWindowsExecutableIcon(executable: Uint8Array, expectedIcon: Uint8Array): void {
  const expected = Data.IconFile.from(expectedIcon).icons.map(item => iconFingerprint(item.data)).sort()
  if (expected.length === 0) throw new Error('The expected Windows ICO contains no icons')
  const pe = NtExecutable.from(executable, { ignoreCert: true })
  const resources = NtExecutableResource.from(pe).entries
  // Explorer uses icon index 0, the first icon group, when no index is supplied.
  const group = Resource.IconGroupEntry.fromEntries(resources)[0]
  if (!group) throw new Error('The Windows executable contains no icon group')
  const actual = group.getIconItemsFromEntries(resources).map(iconFingerprint).sort()
  if (group.icons.length !== expected.length || actual.length !== expected.length
    || actual.some((hash, index) => hash !== expected[index])) {
    throw new Error('The Windows executable icon differs from the application ICO')
  }
}

if (import.meta.main) {
  const [executablePath, expectedIconPath] = process.argv.slice(2)
  if (!executablePath || !expectedIconPath) throw new Error('Usage: bun run assert-windows-icon.ts <executable> <expected.ico>')
  assertWindowsExecutableIcon(readFileSync(executablePath), readFileSync(expectedIconPath))
  console.log('Windows executable embeds the application ICO')
}
