import { z } from 'zod/v4'

const inputSchema = z.object({}).passthrough()

export const TungstenTool = {
  name: 'tungsten',
  aliases: [],
  maxResultSizeChars: 0,
  inputSchema,
  async description() {
    return 'Unavailable in this local recovery build.'
  },
  async prompt() {
    return 'TungstenTool is unavailable in this local recovery build.'
  },
  async call() {
    return {
      data: {
        success: false,
        error: 'TungstenTool is unavailable in this local recovery build.',
      },
    }
  },
  isConcurrencySafe() {
    return true
  },
  isEnabled() {
    return false
  },
  isReadOnly() {
    return true
  },
  async checkPermissions() {
    return {
      behavior: 'deny' as const,
      message: 'TungstenTool is unavailable in this local recovery build.',
    }
  },
}

export function clearSessionsWithTungstenUsage(): void {}

export function resetInitializationState(): void {}
