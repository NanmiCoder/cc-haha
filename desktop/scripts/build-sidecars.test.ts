// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  createCuHelperBuildEnv,
  resolveCuHelperArch,
  shouldBuildCuHelper,
} from './cu-helper-build-target'

describe('cu-helper release target', () => {
  it('builds only on macOS when a stable signing identity is available', () => {
    expect(shouldBuildCuHelper('darwin', 'arm64', 'Developer ID Application: Example')).toBe(true)
    expect(shouldBuildCuHelper('darwin', 'arm64', null)).toBe(false)
    expect(shouldBuildCuHelper('linux', null, null)).toBe(false)
  })

  it('maps both macOS release triples to their native Swift architecture', () => {
    expect(resolveCuHelperArch('aarch64-apple-darwin')).toBe('arm64')
    expect(resolveCuHelperArch('x86_64-apple-darwin')).toBe('x86_64')
  })

  it('overrides a stale host architecture while preserving the signing environment', () => {
    expect(createCuHelperBuildEnv('x86_64-apple-darwin', {
      CU_HELPER_ARCH: 'arm64',
      CU_HELPER_IDENTITY: 'Apple Development: Stale Identity',
      CC_HAHA_SIGN_IDENTITY: 'Developer ID Application: Example',
      PATH: '/usr/bin',
    })).toMatchObject({
      CU_HELPER_ARCH: 'x86_64',
      CU_HELPER_IDENTITY: 'Developer ID Application: Example',
      CC_HAHA_SIGN_IDENTITY: 'Developer ID Application: Example',
      PATH: '/usr/bin',
    })
  })

  it('drops a helper-only identity when no build-wide identity was selected', () => {
    expect(createCuHelperBuildEnv('aarch64-apple-darwin', {
      CU_HELPER_IDENTITY: 'Apple Development: Stale Identity',
    }).CU_HELPER_IDENTITY).toBeUndefined()
  })

  it('skips non-macOS targets and rejects unknown Apple architectures', () => {
    expect(resolveCuHelperArch('x86_64-pc-windows-msvc')).toBeNull()
    expect(resolveCuHelperArch('aarch64-unknown-linux-gnu')).toBeNull()
    expect(() => resolveCuHelperArch('armv7-apple-darwin')).toThrow(
      'unsupported macOS cu-helper target',
    )
  })
})
