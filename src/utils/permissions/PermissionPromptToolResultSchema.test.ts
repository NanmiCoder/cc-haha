import { describe, expect, it } from 'bun:test'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import {
  outputSchema as permissionToolOutputSchema,
  permissionPromptToolResultToPermissionDecision,
} from './PermissionPromptToolResultSchema.js'

function makeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    setAppState: () => {},
  } as unknown as ToolUseContext
}

const tool = { name: 'Write' } as Tool

describe('permissionPromptToolResultToPermissionDecision', () => {
  it('leaves the turn running when a deny omits interrupt', () => {
    const context = makeContext()

    const decision = permissionPromptToolResultToPermissionDecision(
      { behavior: 'deny', message: 'nope' },
      tool,
      { file_path: '/tmp/a.sh' },
      context,
    )

    expect(decision.behavior).toBe('deny')
    // The denial has to survive as a tool_result so the model can see it and
    // write a closing reply. Aborting here ends the turn silently instead.
    expect(context.abortController.signal.aborted).toBe(false)
  })

  it('aborts the turn when a deny explicitly asks to interrupt', () => {
    const context = makeContext()

    permissionPromptToolResultToPermissionDecision(
      { behavior: 'deny', message: 'nope', interrupt: true },
      tool,
      { file_path: '/tmp/a.sh' },
      context,
    )

    expect(context.abortController.signal.aborted).toBe(true)
  })

  it('never aborts on allow', () => {
    const context = makeContext()

    const decision = permissionPromptToolResultToPermissionDecision(
      { behavior: 'allow', updatedInput: {} },
      tool,
      { file_path: '/tmp/a.sh' },
      context,
    )

    expect(decision.behavior).toBe('allow')
    // An empty updatedInput means "use the original" (mobile push responses).
    expect((decision as { updatedInput: unknown }).updatedInput).toEqual({
      file_path: '/tmp/a.sh',
    })
    expect(context.abortController.signal.aborted).toBe(false)
  })

  it('preserves image and text contentBlocks on allow and deny responses', () => {
    const context = makeContext()
    const contentBlocks = [
      {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aGVsbG8=' },
      },
      { type: 'text' as const, text: '[Image source: /tmp/screenshot.png]' },
    ]

    const allowParsed = permissionToolOutputSchema().parse({
      behavior: 'allow',
      updatedInput: { answers: { 'Pick one?': 'A' } },
      contentBlocks,
    })
    const allowDecision = permissionPromptToolResultToPermissionDecision(
      allowParsed,
      tool,
      {},
      context,
    )
    expect(allowDecision.behavior).toBe('allow')
    if (allowDecision.behavior === 'allow') {
      expect(allowDecision.contentBlocks).toEqual(contentBlocks)
    }

    const denyParsed = permissionToolOutputSchema().parse({
      behavior: 'deny',
      message: 'Let us discuss this first.',
      contentBlocks,
    })
    const denyDecision = permissionPromptToolResultToPermissionDecision(
      denyParsed,
      tool,
      {},
      context,
    )
    expect(denyDecision.behavior).toBe('deny')
    if (denyDecision.behavior === 'deny') {
      expect(denyDecision.contentBlocks).toEqual(contentBlocks)
    }
  })

  it('ignores malformed contentBlocks instead of rejecting the permission decision', () => {
    const parsed = permissionToolOutputSchema().parse({
      behavior: 'allow',
      updatedInput: { answers: { 'Pick one?': 'A' } },
      contentBlocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'bad' } }],
    })
    expect(parsed.behavior).toBe('allow')
    expect(parsed.contentBlocks).toBeUndefined()
  })
})
