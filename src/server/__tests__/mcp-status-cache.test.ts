import { describe, expect, it } from 'bun:test'
import { clearStatusCache } from '../api/mcp.js'

describe('MCP status cache', () => {
  it('clearStatusCache does not throw when cache is empty', () => {
    expect(() => clearStatusCache()).not.toThrow()
  })

  it('clearStatusCache with a specific name does not throw', () => {
    expect(() => clearStatusCache('nonexistent-server')).not.toThrow()
  })
})
