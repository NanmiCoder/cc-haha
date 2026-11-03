import { describe, expect, it } from 'vitest'
import {
  getProjectServiceCopies,
  groupProjectServices,
  sortProjectCopies,
} from './mcpServiceGroups'
import type { McpServerRecord } from '../types/mcp'

function server(
  projectPath: string,
  overrides: Partial<McpServerRecord> = {},
): McpServerRecord {
  return {
    name: 'inventory-demo',
    scope: 'project',
    transport: 'stdio',
    enabled: true,
    status: 'connected',
    statusLabel: 'Connected',
    configLocation: `${projectPath}/.mcp.json`,
    summary: 'npx inventory',
    canEdit: true,
    canRemove: true,
    canReconnect: true,
    canToggle: true,
    projectPath,
    config: { type: 'stdio', command: 'npx', args: ['inventory'], env: {} },
    ...overrides,
  }
}

describe('mcpServiceGroups', () => {
  it('groups the same project-scoped name into one service', () => {
    const group = groupProjectServices([
      server('/workspace/b'),
      server('/workspace/a'),
    ], '/workspace/b')[0]!

    expect(group.name).toBe('inventory-demo')
    expect(group.copies).toHaveLength(2)
    expect(group.primary.projectPath).toBe('/workspace/b')
    expect(group.configConsistent).toBe(true)
    expect(group.connectedCount).toBe(2)
  })

  it('marks diverging editable configs as a conflict', () => {
    const group = groupProjectServices([
      server('/workspace/a'),
      server('/workspace/b', {
        config: { type: 'stdio', command: 'npx', args: ['other'], env: {} },
      }),
    ])[0]!

    expect(group.configConsistent).toBe(false)
  })

  it('keeps different names as separate services', () => {
    const groups = groupProjectServices([
      server('/workspace/a'),
      server('/workspace/b', { name: 'other' }),
    ])

    expect(groups.map((group) => group.name)).toEqual(['inventory-demo', 'other'])
  })

  it('does not group user-scoped servers with project copies', () => {
    const groups = groupProjectServices([
      server('/workspace/a'),
      server('/workspace/a', { scope: 'user', projectPath: undefined }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.copies).toHaveLength(1)
  })

  it('sorts the active project first, then by path', () => {
    const copies = sortProjectCopies(
      [server('/workspace/c'), server('/workspace/a'), server('/workspace/b')],
      '/workspace/c',
    )

    expect(copies.map((copy) => copy.projectPath)).toEqual([
      '/workspace/c',
      '/workspace/a',
      '/workspace/b',
    ])
  })

  it('dedupes project copies by project path', () => {
    const copies = getProjectServiceCopies('inventory-demo', [
      server('/workspace/a', { configLocation: '/workspace/.mcp.json' }),
      server('/workspace/a'),
    ])

    expect(copies).toHaveLength(1)
  })
})
