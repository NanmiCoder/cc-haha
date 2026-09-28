import { describe, expect, it } from 'vitest'
import { parseRoutePrefix, routePrefixContains, routePrefixOverlaps, routeProbeAddress } from './routeBinding'

describe('Windows VPN destination boundaries', () => {
  it('accepts an exact IP or canonical CIDR and rejects broad or host-bit prefixes', () => {
    expect(parseRoutePrefix('10.204.19.81')?.prefix).toBe('10.204.19.81/32')
    expect(parseRoutePrefix('10.0.0.0/8')?.prefix).toBe('10.0.0.0/8')
    expect(parseRoutePrefix('10.204.19.1/24')).toBeNull()
    expect(parseRoutePrefix('0.0.0.0/0')).toBeNull()
    expect(parseRoutePrefix('127.0.0.1')).toBeNull()
    expect(parseRoutePrefix('224.0.0.0/8')).toBeNull()
  })

  it('finds more-specific routes that would defeat a broad VPN association', () => {
    expect(routePrefixOverlaps('10.0.0.0/8', '10.204.19.0/24')).toBe(true)
    expect(routePrefixContains('10.0.0.0/8', '10.78.62.2')).toBe(true)
    expect(routePrefixOverlaps('10.55.1.7/32', '10.204.19.0/24')).toBe(false)
    expect(routeProbeAddress('10.55.0.0/16')).toBe('10.55.0.1')
  })
})
