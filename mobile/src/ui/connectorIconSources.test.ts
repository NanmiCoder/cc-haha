import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const desktopLogos = join(import.meta.dir, '..', '..', '..', 'desktop', 'public', 'connectors')
const assets = join(import.meta.dir, '..', '..', 'assets', 'connectors')
// The index contains require('….png'), and bun test does not handle images, so read the key names as text.
const indexed = [...readFileSync(join(import.meta.dir, 'connectorIconSources.ts'), 'utf8').matchAll(/^\s*"([^"]+)": require\(/gm)]
  .map((match) => match[1])
  .sort()

test('every connector logo the desktop ships has a bundled phone icon', () => {
  const ids = readdirSync(desktopLogos)
    .filter((file) => file.endsWith('.svg'))
    .map((file) => file.slice(0, -4))
    .sort()
  // After the desktop adds or changes a logo, run `bun scripts/connector-icons.ts` to regenerate.
  expect(indexed).toEqual(ids)
})

test('the generated PNG file exists for every indexed id', () => {
  expect(indexed.length).toBeGreaterThan(40)
  for (const id of indexed) expect(existsSync(join(assets, `${id}.png`))).toBe(true)
})
