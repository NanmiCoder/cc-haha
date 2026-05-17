import { describe, expect, test } from 'bun:test'
import type { Command } from '../types/command.js'
import { filterCommandsForHeadlessMode } from './headless.js'

describe('filterCommandsForHeadlessMode', () => {
  test('keeps non-interactive commands without exposing local-jsx UI commands', () => {
    const commands = [
      {
        type: 'local-jsx',
        supportsNonInteractive: true,
        name: 'cost',
        description: 'Show cost',
        load: async () => ({ call: async () => null }),
      },
      {
        type: 'local-jsx',
        name: 'config',
        description: 'Open config UI',
        load: async () => ({ call: async () => null }),
      },
      {
        type: 'prompt',
        name: 'review',
        description: 'Review code',
        progressMessage: 'reviewing',
        contentLength: 0,
        source: 'builtin',
        getPromptForCommand: async () => [],
      },
      {
        type: 'prompt',
        name: 'statusline',
        description: 'Hidden from print mode',
        progressMessage: 'checking',
        contentLength: 0,
        source: 'builtin',
        disableNonInteractive: true,
        getPromptForCommand: async () => [],
      },
    ] satisfies Command[]

    expect(filterCommandsForHeadlessMode(commands).map(command => command.name)).toEqual([
      'cost',
      'review',
    ])
  })
})
