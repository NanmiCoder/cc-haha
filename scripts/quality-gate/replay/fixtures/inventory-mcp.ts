#!/usr/bin/env bun
/**
 * A deterministic stdio MCP server for the replay lane's MCP scenario. It never
 * touches the network; the answer is fixed so a recording and every replay see
 * the same tool result.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const STOCK: Record<string, string> = {
  'K-204': 'SKU K-204 (ceramic kettle): 17 units in the Shenzhen warehouse.',
  'M-310': 'SKU M-310 (steel mug): 240 units in the Ningbo warehouse.',
}

const server = new McpServer({ name: 'inventory', version: '1.0.0' })
server.tool(
  'lookup_sku',
  'Look up current stock for one SKU.',
  { sku: z.string().describe('SKU code, for example K-204') },
  async ({ sku }) => ({
    content: [{ type: 'text', text: STOCK[sku.trim().toUpperCase()] ?? `SKU ${sku}: not found.` }],
  }),
)

await server.connect(new StdioServerTransport())
