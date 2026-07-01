import { afterEach, describe, expect, it } from 'vitest'
import { isLspFeatureEnabled } from './lspFeatureFlag'

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_LSP_FLAG = process.env.CLAUDE_CODE_LSP

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV
  if (ORIGINAL_LSP_FLAG === undefined) delete process.env.CLAUDE_CODE_LSP
  else process.env.CLAUDE_CODE_LSP = ORIGINAL_LSP_FLAG
})

describe('isLspFeatureEnabled', () => {
  it('returns true in dev (NODE_ENV !== "production") with no env var', () => {
    process.env.NODE_ENV = 'development'
    delete process.env.CLAUDE_CODE_LSP
    expect(isLspFeatureEnabled()).toBe(true)
  })

  it('returns false in production with no env var', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.CLAUDE_CODE_LSP
    expect(isLspFeatureEnabled()).toBe(false)
  })

  it('returns true in production when CLAUDE_CODE_LSP=1', () => {
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_CODE_LSP = '1'
    expect(isLspFeatureEnabled()).toBe(true)
  })

  it('accepts "true" / "yes" / "on" as truthy', () => {
    process.env.NODE_ENV = 'production'
    for (const value of ['true', 'yes', 'on', 'TRUE', '  YES  ']) {
      process.env.CLAUDE_CODE_LSP = value
      expect(isLspFeatureEnabled()).toBe(true)
    }
  })

  it('returns false when CLAUDE_CODE_LSP is set to a falsy literal', () => {
    process.env.NODE_ENV = 'development'
    for (const value of ['0', 'false', 'no', 'off', '']) {
      process.env.CLAUDE_CODE_LSP = value
      expect(isLspFeatureEnabled()).toBe(false)
    }
  })
})
