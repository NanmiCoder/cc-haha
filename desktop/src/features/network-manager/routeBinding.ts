import { z } from 'zod'

type ParsedPrefix = { address: number; bits: number; prefix: string }

function addressNumber(value: string): number | null {
  if (!z.ipv4().safeParse(value).success) return null
  return value.split('.').reduce((total, octet) => total * 256 + Number(octet), 0)
}

export function parseRoutePrefix(value: string): ParsedPrefix | null {
  const [address, length, extra] = value.trim().split('/')
  if (!address || extra !== undefined) return null
  const numeric = addressNumber(address)
  const bits = length === undefined ? 32 : /^\d{1,2}$/.test(length) ? Number(length) : NaN
  if (numeric === null || !Number.isInteger(bits) || bits < 8 || bits > 32) return null
  const size = 2 ** (32 - bits)
  if (numeric % size !== 0) return null
  const first = Math.floor(numeric / 2 ** 24)
  if (first === 0 || first === 127 || first >= 224 || (first === 169 && Math.floor(numeric / 2 ** 16) % 256 === 254)) return null
  return { address: numeric, bits, prefix: `${address}/${bits}` }
}

export function routePrefixContains(prefix: string, address: string): boolean {
  const parsed = parseRoutePrefix(prefix)
  const numeric = addressNumber(address)
  if (!parsed || numeric === null) return false
  const size = 2 ** (32 - parsed.bits)
  return Math.floor(numeric / size) === Math.floor(parsed.address / size)
}

export function routePrefixOverlaps(left: string, right: string): boolean {
  const a = parseRoutePrefix(left)
  const b = parseRoutePrefix(right)
  if (!a || !b) return false
  const bits = Math.min(a.bits, b.bits)
  const size = 2 ** (32 - bits)
  return Math.floor(a.address / size) === Math.floor(b.address / size)
}

export function routeProbeAddress(prefix: string): string {
  const parsed = parseRoutePrefix(prefix)
  if (!parsed) throw new Error('VPN_ROUTE_DESTINATION_INVALID')
  const numeric = parsed.address + (parsed.bits < 32 ? 1 : 0)
  return [24, 16, 8, 0].map(shift => Math.floor(numeric / 2 ** shift) % 256).join('.')
}
