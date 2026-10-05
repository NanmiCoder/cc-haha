import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTabStore } from '@/stores/tabStore'
import type { UIMessage } from '@/types/chat'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolCallGroup } from './ToolCallGroup'

type GalleryImages = Array<{ src: string; name: string; path?: string }>

// The real lightbox renders; it is wrapped only to record what it was handed.
const lightbox = vi.hoisted(() => ({ images: [] as GalleryImages }))

vi.mock('./ImageGalleryModal', async () => {
  const actual = await vi.importActual<typeof import('./ImageGalleryModal')>('./ImageGalleryModal')
  const { createElement } = await import('react')
  return {
    ImageGalleryModal: (props: ComponentProps<typeof actual.ImageGalleryModal>) => {
      lightbox.images = props.images as GalleryImages
      return createElement(actual.ImageGalleryModal, props)
    },
  }
})

/** Unmistakable in the DOM if it ever leaks: the base64 of a sentence. */
const MARKER = Buffer.from('UNIQUE_IMAGE_PAYLOAD_MARKER').toString('base64')
const IMAGE_BLOCK = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: MARKER } }
const SVG_BLOCK = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/svg+xml', data: Buffer.from('<svg onload="alert(1)"/>').toString('base64') },
}

let counter = 0
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
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
  useTabStore.setState({ activeTabId: 'active-tab', tabs: [{ sessionId: 'active-tab', title: 'Test', type: 'session' as const, status: 'idle' }] })
  useChatStore.setState({ sessions: {} })
  createObjectURL = vi.fn(() => `blob:tool-image-${(counter += 1)}`)
  revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })
})

afterEach(() => {
  cleanup()
  restoreUrlMember('createObjectURL', savedUrlMembers.create)
  restoreUrlMember('revokeObjectURL', savedUrlMembers.revoke)
})

function disclosureOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-chat-disclosure="true"]')!
}

describe('ToolCallBlock · images returned by a tool (#1397)', () => {
  it('shows an image-only shell result as a thumbnail, never as "No output"', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Bash"
        input={{ command: 'python plot.py', description: 'Plot' }}
        result={{ content: [IMAGE_BLOCK], isError: false }}
      />,
    )

    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
    expect(container.textContent).not.toContain('No output')

    fireEvent.click(disclosureOf(container))

    expect(container.textContent).toContain('python plot.py')
    expect(container.textContent).not.toContain('No output')
    // Still exactly one picture: expanding must not add a second copy.
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })

  it('never prints the base64, collapsed or expanded', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Bash"
        input={{ command: 'python plot.py', description: 'Plot' }}
        result={{ content: [IMAGE_BLOCK], isError: false }}
      />,
    )
    expect(container.innerHTML).not.toContain(MARKER)

    fireEvent.click(disclosureOf(container))

    expect(container.innerHTML).not.toContain(MARKER)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:tool-image-1')
  })

  it('shows the thumbnail while the row is still collapsed', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Bash"
        input={{ command: 'python plot.py', description: 'Plot' }}
        result={{ content: [IMAGE_BLOCK], isError: false }}
      />,
    )

    expect(disclosureOf(container)).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('[data-tool-call-details]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
  })

  it('keeps the strip outside the disclosure, after the header, in the card chrome', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="mcp__shots__take"
        input={{ url: 'https://example.com' }}
        result={{ content: [IMAGE_BLOCK], isError: false }}
      />,
    )

    const card = container.querySelector('[data-tool-call-chrome="card"]')!
    const strip = card.querySelector('[data-tool-result-images]')!
    const header = disclosureOf(container)
    expect(strip).toBeTruthy()
    expect(header.contains(strip)).toBe(false)
    expect(header.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders it in the row chrome too, hanging off the row it belongs to', () => {
    const { container } = render(
      <ToolCallBlock
        chrome="row"
        toolName="mcp__shots__take"
        input={{ url: 'https://example.com' }}
        result={{ content: [IMAGE_BLOCK], isError: false }}
      />,
    )

    const row = container.querySelector('[data-tool-call-chrome="row"]')!
    const strip = row.querySelector('[data-tool-result-images]')!
    expect(strip).toBeTruthy()
    expect(disclosureOf(container).contains(strip)).toBe(false)
    // The row has no card padding; the strip hangs under the text column, past
    // the 22px node and its gap, where the expanded details also start.
    expect(strip.className).toMatch(/\bpl-\[30px\]/)
    expect(strip.className).not.toMatch(/\bpx-4\b/)
    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
  })

  it('shows both the text and the picture of a mixed result', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="mcp__shots__take"
        input={{ url: 'https://example.com' }}
        result={{
          content: [{ type: 'text', text: 'Captured example.com' }, IMAGE_BLOCK],
          isError: false,
        }}
      />,
    )

    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
    // One line of output shows in the collapsed header.
    expect(container.textContent).toContain('Captured example.com')

    fireEvent.click(disclosureOf(container))

    expect(container.textContent).toContain('Tool Output')
    expect(container.textContent).toContain('Captured example.com')
    expect(container.innerHTML).not.toContain(MARKER)
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })

  it('still shows a picture that arrives with an error', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="mcp__shots__take"
        input={{ url: 'https://example.com' }}
        result={{ content: [{ type: 'text', text: 'Timed out after 30s' }, IMAGE_BLOCK], isError: true }}
      />,
    )

    expect(container.textContent).toContain('Timed out after 30s')
    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
  })

  it('renders no thumbnail for an image the allowlist refuses, and does not crash', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="mcp__shots__take"
        input={{ url: 'https://example.com' }}
        result={{ content: [SVG_BLOCK], isError: false }}
      />,
    )

    expect(screen.queryByRole('button', { name: /Open image/ })).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    // It does say something was left out, instead of silently showing nothing.
    expect(screen.getByText('Images not shown: 1')).toBeInTheDocument()
    expect(container.innerHTML).not.toContain('onload')
  })

  it('shows the pictures it can and counts the ones it cannot', () => {
    render(
      <ToolCallBlock
        toolName="mcp__shots__take"
        input={{}}
        result={{ content: [IMAGE_BLOCK, SVG_BLOCK], isError: false }}
      />,
    )

    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
    expect(screen.getByText('Images not shown: 1')).toBeInTheDocument()
  })

  it('shows nothing for a call that has not returned', () => {
    const { container } = render(
      <ToolCallBlock toolName="Read" input={{ file_path: '/tmp/pic.png' }} isPending />,
    )

    expect(container.querySelector('[data-tool-result-images]')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it.each([
    ['a plain string', 'const answer = 42'],
    ['text blocks', [{ type: 'text', text: 'line one\nline two' }]],
  ])('leaves %s alone', (_label, content) => {
    const { container } = render(
      <ToolCallBlock toolName="Grep" input={{ pattern: 'answer' }} result={{ content, isError: false }} />,
    )

    expect(container.querySelector('[data-tool-result-images]')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('does not decode again when the parent rebuilds the result object around the same content', () => {
    // ToolCallGroup builds a fresh { content, isError } on every render.
    const content = [IMAGE_BLOCK]
    const { rerender } = render(
      <ToolCallBlock toolName="mcp__shots__take" input={{}} result={{ content, isError: false }} />,
    )

    rerender(<ToolCallBlock toolName="mcp__shots__take" input={{}} result={{ content, isError: false }} />)

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('releases the picture when the row goes away', () => {
    const { unmount } = render(
      <ToolCallBlock toolName="mcp__shots__take" input={{}} result={{ content: [IMAGE_BLOCK], isError: false }} />,
    )

    unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tool-image-1')
  })
})

describe('ToolCallBlock · opening a returned image', () => {
  it('opens the lightbox on the clicked picture', () => {
    render(
      <ToolCallBlock toolName="mcp__shots__take" input={{}} result={{ content: [IMAGE_BLOCK, IMAGE_BLOCK], isError: false }} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open image 2 of 2' }))

    const dialog = screen.getByRole('dialog', { name: 'Image 2 of 2' })
    expect(dialog).toBeInTheDocument()
    expect(dialog.querySelector('img')).toHaveAttribute('src', 'blob:tool-image-2')
    expect(lightbox.images.map((image) => image.src)).toEqual(['blob:tool-image-1', 'blob:tool-image-2'])
  })

  it('offers the original file for a Read of an absolute path', () => {
    render(
      <ToolCallBlock
        toolName="Read"
        input={{ file_path: '/Users/me/project/shots/pic.png' }}
        result={{ content: [IMAGE_BLOCK], isError: false }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open image 1 of 1' }))

    expect(lightbox.images).toEqual([
      { src: 'blob:tool-image-1', name: 'pic.png', path: '/Users/me/project/shots/pic.png' },
    ])
    expect(screen.getByRole('dialog', { name: 'pic.png' })).toBeInTheDocument()
  })

  it('offers no original for a Read of a relative path', () => {
    render(
      <ToolCallBlock
        toolName="Read"
        input={{ file_path: 'shots/pic.png' }}
        result={{ content: [IMAGE_BLOCK], isError: false }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open image 1 of 1' }))

    expect(lightbox.images[0]).not.toHaveProperty('path')
  })

  it('offers no original when a tool other than Read merely has a file_path input', () => {
    // A screenshot tool's file_path is where it may have saved to, not a source
    // the returned pixels are a copy of.
    render(
      <ToolCallBlock
        toolName="mcp__shots__take"
        input={{ file_path: '/Users/me/project/shots/pic.png' }}
        result={{ content: [IMAGE_BLOCK], isError: false }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open image 1 of 1' }))

    expect(lightbox.images[0]).not.toHaveProperty('path')
  })

  it('offers no original for pictures no file produced', () => {
    render(
      <ToolCallBlock
        toolName="Bash"
        input={{ command: 'python plot.py' }}
        result={{ content: [IMAGE_BLOCK], isError: false }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open image 1 of 1' }))

    expect(lightbox.images[0]).not.toHaveProperty('path')
  })
})

describe('ToolCallGroup · images returned by a tool', () => {
  const readCall: Extract<UIMessage, { type: 'tool_use' }> = {
    id: 'read-use',
    type: 'tool_use',
    toolName: 'Read',
    toolUseId: 'read-1',
    input: { file_path: '/Users/me/pic.png' },
    timestamp: 1,
  }
  const grepCall: Extract<UIMessage, { type: 'tool_use' }> = {
    id: 'grep-use',
    type: 'tool_use',
    toolName: 'Grep',
    toolUseId: 'grep-1',
    input: { pattern: 'x' },
    timestamp: 2,
  }
  const resultMap = new Map<string, Extract<UIMessage, { type: 'tool_result' }>>([
    ['read-1', { id: 'read-result', type: 'tool_result', toolUseId: 'read-1', content: [IMAGE_BLOCK], isError: false, timestamp: 3 }],
    ['grep-1', { id: 'grep-result', type: 'tool_result', toolUseId: 'grep-1', content: 'none', isError: false, timestamp: 4 }],
  ])

  function renderGroup(toolCalls: Array<Extract<UIMessage, { type: 'tool_use' }>>) {
    return render(
      <ToolCallGroup
        toolCalls={toolCalls}
        resultMap={resultMap}
        childToolCallsByParent={new Map()}
        agentTaskNotifications={{}}
      />,
    )
  }

  it('shows the picture of a lone tool call', () => {
    renderGroup([readCall])

    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
  })

  it('shows the picture once a run of several calls is opened', () => {
    renderGroup([readCall, grepCall])

    fireEvent.click(screen.getByTestId('activity-group').querySelector('[data-chat-disclosure="true"]')!)

    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
  })
})
