import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/stores/settingsStore'
import type { UIMessage } from '@/types/chat'
import type { GalleryImage } from '@/components/chat/conversationImageGallery'
import { ActivityGroup } from './ActivityGroup'
import type { ActivityStep } from './activityGroupModel'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>
type GalleryImages = GalleryImage[]

// The lightbox has its own tests; here it only records what each strip hands it.
const lightbox = vi.hoisted(() => ({ images: [] as GalleryImages }))

vi.mock('./ImageGalleryModal', () => ({
  ImageGalleryModal: (props: { images: GalleryImages; activeIndex: number }) => {
    lightbox.images = props.images
    return <div role="dialog" aria-label={props.images[props.activeIndex]?.name} />
  },
}))

function picture(label: string, mediaType = 'image/png') {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: Buffer.from(label).toString('base64') } }
}

function toolCall(overrides: Partial<ToolCall> & Pick<ToolCall, 'id' | 'toolUseId' | 'toolName'>): ToolCall {
  return { type: 'tool_use', input: {}, timestamp: 0, ...overrides }
}

function toolResult(toolUseId: string, content: unknown): ToolResult {
  return { id: `result-${toolUseId}`, type: 'tool_result', toolUseId, content, isError: false, timestamp: 0 }
}

function resultsOf(results: ToolResult[]): Map<string, ToolResult> {
  return new Map(results.map((result) => [result.toolUseId, result]))
}

function stepsOf(...calls: ToolCall[]): ActivityStep[] {
  return calls.map((call) => ({ kind: 'tool' as const, toolCall: call }))
}

const readA = toolCall({ id: 'use-read-a', toolUseId: 'read-a', toolName: 'Read', input: { file_path: '/repo/shots/a.png' }, timestamp: 1_000 })
const readB = toolCall({ id: 'use-read-b', toolUseId: 'read-b', toolName: 'Read', input: { file_path: '/repo/shots/b.png' }, timestamp: 2_000 })
// A screenshot tool that may have written a file: that path is not what its pixels are a copy of.
const shot = toolCall({
  id: 'use-shot',
  toolUseId: 'shot-1',
  toolName: 'mcp__browser__screenshot',
  input: { file_path: '/repo/shots/written-by-the-tool.png' },
  timestamp: 3_000,
})
const bash = toolCall({ id: 'use-bash', toolUseId: 'bash-1', toolName: 'Bash', input: { command: 'ls shots' }, timestamp: 4_000 })

let counter = 0
let createObjectURL: ReturnType<typeof vi.fn>
const savedUrlMembers = {
  create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
  revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
}

function restoreUrlMember(name: 'createObjectURL' | 'revokeObjectURL', saved: PropertyDescriptor | undefined) {
  if (saved) Object.defineProperty(URL, name, saved)
  else delete (URL as unknown as Record<string, unknown>)[name]
}

beforeEach(() => {
  counter = 0
  lightbox.images = []
  useSettingsStore.setState({ locale: 'en' })
  createObjectURL = vi.fn(() => `blob:run-${(counter += 1)}`)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
})

afterEach(() => {
  cleanup()
  restoreUrlMember('createObjectURL', savedUrlMembers.create)
  restoreUrlMember('revokeObjectURL', savedUrlMembers.revoke)
})

function renderGroup(
  steps: ActivityStep[],
  resultMap: Map<string, ToolResult>,
  props: Partial<Parameters<typeof ActivityGroup>[0]> = {},
) {
  return render(
    <ActivityGroup steps={steps} resultMap={resultMap} childToolCallsByParent={new Map()} {...props} />,
  )
}

function groupOf(): HTMLElement {
  return screen.getByTestId('activity-group')
}

function summaryOf(group: HTMLElement): HTMLElement {
  return group.querySelector<HTMLElement>('[data-chat-disclosure="true"]')!
}

function stripsIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-tool-result-images]')]
}

/** How many times a base64 string was copied for validation while `run` ran. */
function countValidations(run: () => void): number {
  const original = String.prototype.replace as (this: string, ...args: unknown[]) => string
  let validations = 0
  const spy = vi.spyOn(String.prototype, 'replace').mockImplementation(function (this: string, ...args: unknown[]) {
    const [pattern] = args
    if (pattern instanceof RegExp && pattern.source === '[\\t\\n\\f\\r ]+') validations += 1
    return original.apply(this, args)
  } as never)
  try {
    run()
  } finally {
    spy.mockRestore()
  }
  return validations
}

describe('ActivityGroup · pictures in a folded run (#1397)', () => {
  const steps = stepsOf(readA, readB)
  const results = resultsOf([
    toolResult('read-a', [picture('first picture')]),
    toolResult('read-b', [picture('second picture')]),
  ])

  it('shows each tool\'s pictures directly under the folded summary', () => {
    renderGroup(steps, results)
    const group = groupOf()

    expect(group).toHaveAttribute('data-expanded', 'false')
    const [summary, first, second, ...rest] = [...group.children] as HTMLElement[]
    expect(rest).toEqual([])
    expect(summary).toBe(summaryOf(group))
    expect(first).toHaveAttribute('data-tool-result-images')
    expect(second).toHaveAttribute('data-tool-result-images')
    expect(within(first!).getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
    expect(within(second!).getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
    expect(screen.getAllByRole('group', { name: 'Read result' })).toHaveLength(2)
  })

  it('keys each strip by its own call, so two Reads do not collide', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    renderGroup(steps, results)

    const errors = consoleError.mock.calls.map((call) => String(call[0]))
    consoleError.mockRestore()
    expect(errors).toEqual([])
    expect(stripsIn(groupOf())).toHaveLength(2)
  })

  it('pads the strips a little and does not indent them past the summary text', () => {
    renderGroup(steps, results)

    for (const strip of stripsIn(groupOf())) {
      expect(strip).toHaveClass('pt-1', 'pb-1')
      expect(strip.className).not.toMatch(/(^|\s)(?:pl|px|ml|mx)-/)
    }
  })

  it('offers each strip\'s own original in its lightbox', () => {
    renderGroup(steps, results)
    const [first, second] = stripsIn(groupOf())

    fireEvent.click(within(first!).getByRole('button', { name: 'Open image 1 of 1' }))
    expect(lightbox.images).toEqual([{
      src: 'blob:run-1', name: 'a.png', path: '/repo/shots/a.png',
      inline: { mediaType: 'image/png', data: btoa('first picture') },
    }])

    fireEvent.click(within(second!).getByRole('button', { name: 'Open image 1 of 1' }))
    expect(lightbox.images).toEqual([{
      src: 'blob:run-2', name: 'b.png', path: '/repo/shots/b.png',
      inline: { mediaType: 'image/png', data: btoa('second picture') },
    }])
  })

  it('keeps every strip with its own tool, in step order, and skips calls with nothing to show', () => {
    const mixed = stepsOf(readA, bash, shot, readB)
    renderGroup(mixed, resultsOf([
      toolResult('read-a', [picture('a')]),
      toolResult('bash-1', 'shots listed'),
      toolResult('shot-1', [{ type: 'text', text: 'captured' }, picture('shot'), picture('shot too')]),
      toolResult('read-b', [picture('b')]),
    ]))
    const strips = stripsIn(groupOf())

    expect(strips.map((strip) => strip.getAttribute('aria-label'))).toEqual([
      'Read result',
      'mcp__browser__screenshot result',
      'Read result',
    ])
    expect(strips.map((strip) => within(strip).getAllByRole('img').length)).toEqual([1, 2, 1])

    fireEvent.click(within(strips[0]!).getByRole('button', { name: 'Open image 1 of 1' }))
    expect(lightbox.images[0]).toMatchObject({ path: '/repo/shots/a.png' })

    // Only Read names its source: the screenshot tool's file_path must not leak in.
    fireEvent.click(within(strips[1]!).getByRole('button', { name: 'Open image 2 of 2' }))
    expect(lightbox.images.every((image) => !('path' in image))).toBe(true)

    fireEvent.click(within(strips[2]!).getByRole('button', { name: 'Open image 1 of 1' }))
    expect(lightbox.images[0]).toMatchObject({ path: '/repo/shots/b.png' })
  })

  it('says so under the summary when a picture could not be shown', () => {
    renderGroup(stepsOf(readA, bash), resultsOf([
      toolResult('read-a', [picture('<svg/>', 'image/svg+xml')]),
      toolResult('bash-1', 'ok'),
    ]))
    const [strip, ...others] = stripsIn(groupOf())

    expect(others).toEqual([])
    expect(within(strip!).getByText('Images not shown: 1')).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('shows nothing for a call whose result has not arrived', () => {
    renderGroup(stepsOf(readA, readB), resultsOf([toolResult('read-b', [picture('b')])]))

    const strips = stripsIn(groupOf())
    expect(strips).toHaveLength(1)
    expect(strips[0]).toHaveAccessibleName('Read result')
  })

  it('picks up a picture whose result lands after the group first rendered', () => {
    const steps = stepsOf(readA, readB)
    const { rerender } = renderGroup(steps, resultsOf([toolResult('read-b', 'text only')]))
    expect(stripsIn(groupOf())).toEqual([])

    rerender(
      <ActivityGroup
        steps={steps}
        resultMap={resultsOf([toolResult('read-a', [picture('late picture')]), toolResult('read-b', 'text only')])}
        childToolCallsByParent={new Map()}
      />,
    )

    expect(stripsIn(groupOf())).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
  })

  it('leaves the pictures of calls a tool dispatched to their own rows', () => {
    const child = toolCall({ id: 'use-child', toolUseId: 'child-1', toolName: 'Read', input: { file_path: '/repo/shots/child.png' }, parentToolUseId: 'bash-1' })
    render(
      <ActivityGroup
        steps={stepsOf(readA, bash)}
        resultMap={resultsOf([
          toolResult('read-a', 'text only'),
          toolResult('bash-1', 'ok'),
          toolResult('child-1', [picture('child')]),
        ])}
        childToolCallsByParent={new Map([['bash-1', [child]]])}
      />,
    )

    expect(stripsIn(groupOf())).toEqual([])
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('stays out of the way of a run that returned no pictures', () => {
    renderGroup(stepsOf(readA, bash), resultsOf([
      toolResult('read-a', [{ type: 'text', text: 'const a = 1' }]),
      toolResult('bash-1', 'ok'),
    ]))
    const group = groupOf()

    // Just the summary line, as before: no wrapper, no empty strip.
    expect([...group.children]).toEqual([summaryOf(group)])
    expect(stripsIn(document.body)).toEqual([])
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})

describe('ActivityGroup · pictures in an open run', () => {
  const steps = stepsOf(readA, readB)
  const results = resultsOf([
    toolResult('read-a', [picture('first picture')]),
    toolResult('read-b', [picture('second picture'), picture('third picture')]),
  ])

  it('shows each picture once, in its own row, and none under the summary', () => {
    renderGroup(steps, results, { isLive: true })
    const group = groupOf()

    expect(group).toHaveAttribute('data-expanded', 'true')
    const strips = stripsIn(group)
    expect(strips).toHaveLength(2)
    for (const strip of strips) {
      expect(strip.closest('[data-tool-call-chrome="row"]')).not.toBeNull()
      expect(strip.parentElement).not.toBe(group)
    }
    expect(within(group).getAllByRole('img')).toHaveLength(3)
  })

  it('moves the pictures between the rows and the summary as the reader folds and opens it', () => {
    renderGroup(steps, results, { isLive: true })
    const group = groupOf()
    const imagesShown = () => within(group).getAllByRole('img').length

    fireEvent.click(summaryOf(group))
    expect(group).toHaveAttribute('data-expanded', 'false')
    expect(stripsIn(group)).toHaveLength(2)
    expect(stripsIn(group).every((strip) => strip.parentElement === group)).toBe(true)
    expect(imagesShown()).toBe(3)

    fireEvent.click(summaryOf(group))
    expect(group).toHaveAttribute('data-expanded', 'true')
    expect(stripsIn(group)).toHaveLength(2)
    expect(stripsIn(group).every((strip) => strip.parentElement !== group)).toBe(true)
    expect(imagesShown()).toBe(3)
  })

  it('shows the pictures of a live run the reader has folded', () => {
    renderGroup(steps, results, { isLive: true, isStreaming: true })
    expect(stripsIn(groupOf()).every((strip) => strip.closest('[data-tool-call-chrome="row"]'))).toBe(true)

    fireEvent.click(summaryOf(groupOf()))

    expect(groupOf()).toHaveAttribute('data-expanded', 'false')
    expect(stripsIn(groupOf())).toHaveLength(2)
    expect(stripsIn(groupOf()).every((strip) => strip.parentElement === groupOf())).toBe(true)
  })
})

describe('ActivityGroup · a run of one call', () => {
  it('shows the picture once, in its row, as it did before', () => {
    renderGroup(stepsOf(readA), resultsOf([toolResult('read-a', [picture('only picture')])]))
    const group = groupOf()

    expect(group).toHaveAttribute('data-single-step', 'true')
    const strips = stripsIn(group)
    expect(strips).toHaveLength(1)
    expect(strips[0]!.closest('[data-tool-call-chrome="row"]')).not.toBeNull()
    expect(within(group).getAllByRole('img')).toHaveLength(1)
  })

  it('shows the picture of its row once the result arrives', () => {
    const steps = stepsOf(readA)
    const { rerender } = renderGroup(steps, resultsOf([]))
    expect(stripsIn(document.body)).toEqual([])

    rerender(
      <ActivityGroup
        steps={steps}
        resultMap={resultsOf([toolResult('read-a', [picture('late picture')])])}
        childToolCallsByParent={new Map()}
      />,
    )

    expect(stripsIn(groupOf())).toHaveLength(1)
    expect(stripsIn(groupOf())[0]!.closest('[data-tool-call-chrome="row"]')).not.toBeNull()
  })
})

describe('ActivityGroup · reading pictures while a turn streams', () => {
  it('validates each picture once, however often the group renders around it', () => {
    const steps = stepsOf(readA, readB)
    const contents = { a: [picture('first picture')], b: [picture('second picture')] }
    const results = resultsOf([toolResult('read-a', contents.a), toolResult('read-b', contents.b)])

    const validations = countValidations(() => {
      const { rerender } = renderGroup(steps, results)
      // The transcript rebuilds its result map and step arrays for every token; the
      // results in them are the same objects.
      for (let token = 0; token < 4; token += 1) {
        rerender(
          <ActivityGroup
            steps={[...steps]}
            resultMap={new Map(results)}
            childToolCallsByParent={new Map()}
            isStreaming={token % 2 === 0}
            activeThinkingId={`thinking-${token}`}
          />,
        )
      }
      // Opening and folding again mounts the rows and the summary strips anew.
      fireEvent.click(summaryOf(groupOf()))
      fireEvent.click(summaryOf(groupOf()))
    })

    expect(validations).toBe(2)
    expect(stripsIn(groupOf())).toHaveLength(2)
  })

  it('does not decode the pictures again either', () => {
    const results = resultsOf([toolResult('read-a', [picture('first picture')]), toolResult('bash-1', 'ok')])
    const { rerender } = renderGroup(stepsOf(readA, bash), results)
    expect(createObjectURL).toHaveBeenCalledTimes(1)

    rerender(
      <ActivityGroup
        steps={stepsOf(readA, bash)}
        resultMap={new Map(results)}
        childToolCallsByParent={new Map()}
        isStreaming
      />,
    )

    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })
})
