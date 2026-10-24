import { z } from 'zod/v4'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk/core'

export type ExtensionTool = {
  name: string
  description: string
  schema: z.ZodType
  readOnly?: boolean
  call(input: any, signal: AbortSignal, toolUseId?: string): Promise<unknown>
}

export function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }
}

export function createExtensionServer(name: string, tools: ExtensionTool[]): McpSdkServerConfigWithInstance {
  const instance = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({
    name: tool.name, description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema, { target: 'draft-7' }) as { type: 'object' },
    ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
  })) }))
  instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.find(item => item.name === request.params.name)
    if (!tool) return { isError: true, ...textResult(`Unknown cc-hh tool: ${request.params.name}`) }
    try {
      if (extra.signal.aborted) throw new Error('Tool call cancelled')
      return textResult(await tool.call(tool.schema.parse(request.params.arguments ?? {}), extra.signal,
        typeof request.params._meta?.['claudecode/toolUseId'] === 'string' ? request.params._meta['claudecode/toolUseId'] : undefined))
    } catch (error) {
      return { isError: true, ...textResult(error instanceof Error ? error.message : 'cc-hh tool failed') }
    }
  })
  return { type: 'sdk', name, instance }
}
