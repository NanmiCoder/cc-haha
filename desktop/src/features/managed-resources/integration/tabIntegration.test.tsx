import { describe, expect, it } from 'vitest'
import { HostsTabButton } from '../ui/tabIntegration'

describe('HostsTabButton (M2.2)', () => {
  it('exports tab integration button', () => {
    expect(typeof HostsTabButton).toBe('function')
  })
})
