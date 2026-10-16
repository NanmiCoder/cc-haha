// @vitest-environment node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NtExecutable } from 'resedit'
import { describe, expect, it } from 'vitest'
import { assertWindowsConsoleSubsystem, readWindowsSubsystem } from './assert-windows-console-subsystem'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))

function executableWithSubsystem(subsystem: number, is32Bit = false): Buffer {
  const executable = NtExecutable.createEmpty(is32Bit, false)
  executable.newHeader.optionalHeader.subsystem = subsystem
  return Buffer.from(executable.generate())
}

describe('Windows sidecar console subsystem', () => {
  it.each([false, true])('reads the subsystem from the real PE header (32-bit=%s)', is32Bit => {
    expect(readWindowsSubsystem(executableWithSubsystem(3, is32Bit))).toBe(3)
    expect(readWindowsSubsystem(executableWithSubsystem(2, is32Bit))).toBe(2)
  })

  it('accepts a console-subsystem executable', () => {
    expect(() => assertWindowsConsoleSubsystem(executableWithSubsystem(3), 'Sidecar')).not.toThrow()
  })

  it('rejects the GUI subsystem that hideConsole produces with Bun 1.4', () => {
    expect(() => assertWindowsConsoleSubsystem(executableWithSubsystem(2), 'Sidecar'))
      .toThrow('Sidecar must be a console-subsystem (CUI) executable but was built for the GUI subsystem')
  })

  it('rejects bytes that are not a PE executable', () => {
    expect(() => readWindowsSubsystem(Buffer.from('not a PE executable'))).toThrow('missing MZ header')
    const truncated = executableWithSubsystem(3).subarray(0, 0x40)
    expect(() => readWindowsSubsystem(truncated)).toThrow('missing PE header')
  })

  it('is enforced on the compiled Windows sidecar, which no longer asks Bun to hide the console', () => {
    const source = readFileSync(path.join(scriptsDir, 'build-sidecars.ts'), 'utf8')
    expect(source).not.toMatch(/hideConsole\s*:\s*true/)
    expect(source).toMatch(/if \(bunTarget\.startsWith\('bun-windows-'\)\) \{[\s\S]*?assertWindowsConsoleSubsystem\(header, productName\)/)
  })
})
