// @vitest-environment node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_DESKTOP_UPSTREAM_COMMIT } from './native-agent-desktop'

const sourceRoot = path.resolve(import.meta.dirname, '../../native/agent-desktop')
const upstream = JSON.parse(readFileSync(path.join(sourceRoot, 'UPSTREAM.json'), 'utf8')) as {
  commit: string
  files: Record<string, string>
}
const localPatches = [
  'crates/core/src/cursor_overlay/mod.rs',
  'crates/core/src/lib.rs',
  'crates/linux/src/system/overlay/cursor_overlay_draw.rs',
  'crates/windows/src/system/cursor_overlay/geometry.rs',
  'crates/windows/src/system/cursor_overlay/geometry_tests.rs',
  'src/cli/mod.rs',
  'tests/e2e-windows/scenarios/Interaction.ps1',
  'tests/fixture-app-windows/FixtureCardsClicks.cs',
]

describe('vendored agent-desktop source', () => {
  it('keeps every original source byte except the recorded integration patches', () => {
    expect(upstream.commit).toBe(AGENT_DESKTOP_UPSTREAM_COMMIT)
    const changed: string[] = []
    for (const [name, expectedHash] of Object.entries(upstream.files)) {
      const content = readFileSync(path.join(sourceRoot, name))
      if (createHash('sha256').update(content).digest('hex') !== expectedHash) changed.push(name)
    }
    expect(changed.sort()).toEqual([...localPatches].sort())
  })

  it('retains every literal compile-time include used by upstream Rust tests and embedded skills', () => {
    for (const name of Object.keys(upstream.files).filter(name => name.endsWith('.rs'))) {
      const source = readFileSync(path.join(sourceRoot, name), 'utf8')
      for (const match of source.matchAll(/include_(?:str|bytes)!\s*\(\s*"([^"]+)"/g)) {
        const dependency = path.resolve(sourceRoot, path.dirname(name), match[1])
        expect(() => readFileSync(dependency), `${name} includes ${match[1]}`).not.toThrow()
      }
    }
  })

  it('keeps the product arrow coordinates tied to the Swift helper reference', () => {
    const swift = readFileSync(path.resolve(sourceRoot, '../cu-helper/Sources/cu-helper/VirtualCursorStyle.swift'), 'utf8')
    const rust = readFileSync(path.join(sourceRoot, 'crates/core/src/cursor_overlay/product_cursor.rs'), 'utf8')
    const points = [...swift.matchAll(/CGPoint\(x:\s*([\d.]+),\s*y:\s*([\d.]+)\)/g)]
      .map(match => [Number(match[1]), Number(match[2])])
    expect(points).toHaveLength(7)
    for (const [x, y] of points.slice(1)) {
      if (x !== 0) expect(rust).toContain(`${x.toFixed(1)} * 22.0 / 19.0`)
      expect(rust).toContain(`${y.toFixed(1)} * 22.0 / 19.0`)
    }
  })
})
