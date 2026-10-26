import { describe, expect, test } from 'bun:test'
import {
  SUGGESTED_CONNECTOR_IDS,
  connectorSections,
  isPluginIdVisible,
  normalizeConnectors,
  type Connector,
} from './connectors'

const make = (id: string, extra: Partial<Connector> = {}): Connector => ({
  id,
  displayName: id,
  supported: true,
  installed: false,
  connection: 'disconnected',
  status: 'not-installed',
  pluginId: `${id}@haha-connectors`,
  ...extra,
})
const ids = (list: Connector[]) => list.map((connector) => connector.id)

describe('normalizeConnectors', () => {
  test('keeps only the fields the phone uses and ignores malformed entries', () => {
    const result = normalizeConnectors({
      items: [
        { id: 'github', displayName: 'GitHub', connection: 'connected', installed: true, authUrl: 'https://secret', operation: { kind: 'check', phase: 'x', authUrl: 'u' } },
        { displayName: 'no id' },
        null,
        'junk',
        { id: 'n', supported: 'yes', installed: 1 },
      ],
    })
    expect(result).toEqual([
      { id: 'github', displayName: 'GitHub', connection: 'connected', installed: true, operation: { kind: 'check', phase: 'x' } },
      { id: 'n' },
    ].map((value) => expect.objectContaining(value)))
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result![1]!.supported).toBeUndefined()
  })

  test('anything that is not an items list means the desktop has no usable connector API', () => {
    expect(normalizeConnectors({ error: 'Desktop-only capability' })).toBeNull()
    expect(normalizeConnectors({ items: 'x' })).toBeNull()
    expect(normalizeConnectors(null)).toBeNull()
    expect(normalizeConnectors({ items: [] })).toEqual([])
  })
})

describe('connectorSections', () => {
  const catalog: Connector[] = [
    make('github', { installed: true, connection: 'connected', status: 'ready' }),
    make('feishu', { installed: true, connection: 'needs-auth', status: 'needs-auth' }),
    make('dingtalk', { installed: true, connection: 'disconnected', status: 'error' }),
    make('context7'),
    make('notion'),
    make('figma'),
    make('linear'),
    make('wecom', { installed: true, connection: 'disconnected', status: 'disabled' }),
    make('unsupported', { supported: false }),
    make('bundle', { transport: 'skills' }),
    make('tools', { collection: 'tools' }),
    make('busy', { installed: true, connection: 'needs-auth', operation: { kind: 'authenticate' } }),
    make('office-mcp', { pluginId: 'office-mcp-builder@haha-connectors' }),
  ]

  test('connected, needs attention, three suggestions and the rest follow the desktop rules', () => {
    const sections = connectorSections(catalog)
    expect(ids(sections.connected)).toEqual(['github'])
    expect(ids(sections.attention)).toEqual(['feishu', 'dingtalk'])
    // Fixed list order, installed ones skipped, capped at three.
    expect(ids(sections.suggested)).toEqual(['context7', 'notion', 'figma'])
    expect(ids(sections.rest)).toEqual(['linear', 'wecom', 'busy'])
  })

  test('unsupported platforms, skill bundles, tool collections and withdrawn packages never show', () => {
    const everything = Object.values(connectorSections(catalog)).flat()
    for (const hidden of ['unsupported', 'bundle', 'tools', 'office-mcp']) expect(ids(everything)).not.toContain(hidden)
  })

  test('an installed suggestion moves the next one in line up; busy ones are not suggested', () => {
    const sections = connectorSections([
      make('github', { installed: true, connection: 'connected' }),
      make('feishu', { installed: true, connection: 'needs-auth' }),
      make('context7', { operation: { kind: 'prepare' } }),
      make('notion'),
      make('figma'),
      make('tencent-docs'),
      make('linear'),
    ])
    expect(ids(sections.suggested)).toEqual(['notion', 'figma', 'tencent-docs'])
    expect(ids(sections.rest)).toEqual(['context7', 'linear'])
  })

  test('the suggestion list is the desktop one', () => {
    expect(SUGGESTED_CONNECTOR_IDS.slice(0, 4)).toEqual(['github', 'feishu', 'context7', 'notion'])
    expect(SUGGESTED_CONNECTOR_IDS).toHaveLength(10)
  })

  test('an empty catalog has no sections', () => {
    expect(connectorSections([])).toEqual({ connected: [], attention: [], suggested: [], rest: [] })
  })
})

test('withdrawn managed plugins are hidden but same-named personal plugins are not', () => {
  expect(isPluginIdVisible('office-mcp-builder@haha-connectors')).toBe(false)
  expect(isPluginIdVisible('office-mcp-builder@mine')).toBe(true)
  expect(isPluginIdVisible('feishu@haha-connectors')).toBe(true)
  expect(isPluginIdVisible('')).toBe(true)
})

test('native connectors without a display name get their Chinese name, others keep the server value', () => {
  const list = normalizeConnectors({
    items: [
      { id: 'feishu', supported: true },
      { id: 'github', displayName: 'GitHub', description: '检索仓库代码。', supported: true },
      { id: 'unknown-service', supported: true },
    ],
  })!
  expect(list.map((item) => [item.id, item.displayName])).toEqual([
    ['feishu', '飞书'],
    ['github', 'GitHub'],
    ['unknown-service', undefined],
  ])
  expect(list[0].description).toBe('管理飞书文档、日历与办公协作。')
})
