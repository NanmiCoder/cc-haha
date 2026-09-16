import { describe, expect, mock, test } from 'bun:test'
import type { Command } from '../commands.js'
import type { Tool } from '../Tool.js'
import type { ConnectedMCPServer } from '../services/mcp/types.js'
import { disableStaleMcpReconnect } from './mcpReconnectState.js'

describe('disableStaleMcpReconnect', () => {
  test('closes only the stale connection and removes its state', () => {
    const cleanup = mock(async () => {})
    const staleClient: ConnectedMCPServer = {
      name: 'test-server',
      type: 'connected',
      client: {} as ConnectedMCPServer['client'],
      capabilities: {},
      config: { type: 'sse', url: 'https://old.example.com/mcp' },
      cleanup,
    }
    const otherClient = {
      name: 'other',
      type: 'pending' as const,
      config: { type: 'stdio' as const, command: 'other' },
    }
    const testTool = { name: 'mcp__test-server__lookup' } as Tool
    const otherTool = { name: 'mcp__other__lookup' } as Tool
    const testCommand = { name: 'mcp__test-server__prompt' } as Command
    const otherCommand = { name: 'mcp__other__prompt' } as Command

    const result = disableStaleMcpReconnect(
      'test-server',
      { type: 'sse', url: 'https://new.example.com/mcp' },
      staleClient,
      {
        clients: [staleClient, otherClient],
        tools: [testTool, otherTool],
        commands: [testCommand, otherCommand],
        resources: { 'test-server': [], other: [] },
      },
      {
        clients: [staleClient, otherClient],
        tools: [testTool, otherTool],
        configs: {},
      },
    )

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(result.mcp).toEqual({
      clients: [
        {
          name: 'test-server',
          type: 'disabled',
          config: { type: 'sse', url: 'https://new.example.com/mcp' },
        },
        otherClient,
      ],
      tools: [otherTool],
      commands: [otherCommand],
      resources: { other: [] },
    })
    expect(result.dynamic).toEqual({
      clients: [
        otherClient,
        {
          name: 'test-server',
          type: 'disabled',
          config: { type: 'sse', url: 'https://new.example.com/mcp' },
        },
      ],
      tools: [otherTool],
      configs: {},
    })
  })

  test('does not close a non-connected stale result', () => {
    expect(
      disableStaleMcpReconnect(
        'test-server',
        { type: 'stdio', command: 'test' },
        {
          name: 'test-server',
          type: 'failed',
          config: { type: 'stdio', command: 'test' },
        },
        { clients: [], tools: [], commands: [], resources: {} },
        { clients: [], tools: [], configs: {} },
      ).mcp.clients,
    ).toEqual([])
  })
})
