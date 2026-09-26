import React from 'react'
import { Box, Text } from '../../ink.js'
import type { ToolProgressData } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import type { Output } from './VccRecallTool.js'

export function renderToolUseMessage(
  { query, mode }: Partial<{ query?: string; mode?: string }>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!query && !mode) return null
  const parts: string[] = []
  if (query) parts.push(`query: "${query}"`)
  if (mode && mode !== 'hybrid') parts.push(`mode: ${mode}`)
  return parts.join(', ')
}

export function renderToolResultMessage(
  { text }: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!text) return null
  // Recall output is plain multi-line text; the non-verbose view collapses it
  // to the first line so the transcript stays scannable.
  const firstLine = text.split('\n')[0] ?? ''
  if (!verbose) {
    return (
      <Box flexDirection="row">
        <Text dimColor>{firstLine}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>{text}</Text>
    </Box>
  )
}
