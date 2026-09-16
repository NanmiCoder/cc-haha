import { describe, expect, test } from 'bun:test'
import { DOMESTIC_ENTRIES } from './domesticCatalog.js'

describe('supplier-documented domestic connectors', () => {
  test('preserves provider-specific authentication and region boundaries', () => {
    const entries = Object.fromEntries(DOMESTIC_ENTRIES.map(entry => [entry.id, entry]))
    expect(entries.kuaicha?.auth).toEqual({ type: 'api-key', in: 'header', name: 'open-authorization', prefix: 'Bearer ' })
    expect(entries.bazhuayu?.auth).toEqual({ type: 'api-key', in: 'header', name: 'x-api-key' })
    expect(entries.xmind?.endpoint).toBe('https://app.xmind.cn/api/mcp')
    expect(entries.qcc?.endpoint).toBe('https://agent.qcc.com/mcp/company/stream')
    expect(entries.jufa?.endpoint).toBe('https://www.jufaai.com/mcp/case')
    expect(entries.sorftime?.auth).toEqual({ type: 'api-key', in: 'header', name: 'Authorization', prefix: 'Bearer ' })
    expect(DOMESTIC_ENTRIES).toHaveLength(10)
    expect(new Set(DOMESTIC_ENTRIES.map(entry => entry.id)).size).toBe(10)
    for (const entry of DOMESTIC_ENTRIES) {
      expect(entry.region).toBe('china')
      expect(new URL(entry.endpoint).protocol).toBe('https:')
      expect(new URL(entry.source).protocol).toBe('https:')
      expect(new URL(entry.endpoint).search).toBe('')
      expect(entry.requirements.length).toBeGreaterThan(15)
    }
  })
})

test('ships local, inert brand assets for every domestic entry', async () => {
  for (const entry of DOMESTIC_ENTRIES) {
    const url = new URL(`../../../desktop/public/connectors/${entry.id}.svg`, import.meta.url)
    const svg = await Bun.file(url).text()
    expect(svg).toContain('<svg')
    expect(svg).not.toMatch(/<script|<foreignObject|<!DOCTYPE|\bon[a-z]+\s*=|javascript:/i)
    expect(svg).not.toMatch(/(?:href|src)=["']https?:/i)
  }
})
