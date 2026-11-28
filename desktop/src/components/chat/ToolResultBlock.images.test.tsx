import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/stores/settingsStore'
import { ToolResultBlock } from './ToolResultBlock'

const MARKER = Buffer.from('UNIQUE_IMAGE_PAYLOAD_MARKER').toString('base64')
const IMAGE_BLOCK = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: MARKER } }
const SVG_BLOCK = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') },
}

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
  useSettingsStore.setState({ locale: 'en' })
  createObjectURL = vi.fn(() => `blob:standalone-${(counter += 1)}`)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
})

afterEach(() => {
  cleanup()
  restoreUrlMember('createObjectURL', savedUrlMembers.create)
  restoreUrlMember('revokeObjectURL', savedUrlMembers.revoke)
})

describe('ToolResultBlock · images returned by a tool (#1397)', () => {
  it('shows the picture of an image-only result, with no empty text preview under it', () => {
    const { container } = render(
      <ToolResultBlock content={[IMAGE_BLOCK]} isError={false} toolName="mcp__shots__take" />,
    )

    expect(screen.getByRole('group', { name: 'mcp__shots__take result' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:standalone-1')
    // The text preview is a monospace band; there is no text to put in it.
    expect(container.querySelector('.font-mono')).toBeNull()
    expect(container.innerHTML).not.toContain(MARKER)
  })

  it('keeps the text behind the quiet disclosure when the result has text as well', () => {
    const { container } = render(
      <ToolResultBlock content={[{ type: 'text', text: 'Captured example.com' }, IMAGE_BLOCK]} isError={false} />,
    )

    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Tool result' })).toBeInTheDocument()
    // Collapsed by default: no 200-char monospace preview slab until clicked.
    expect(container.querySelector('.font-mono')).toBeNull()
    fireEvent.click(container.querySelector('[data-chat-disclosure="true"]')!)
    expect(container.textContent).toContain('Captured example.com')
  })

  it('shows the picture of a failed result as well', () => {
    const { container } = render(
      <ToolResultBlock content={[{ type: 'text', text: 'Partial capture' }, IMAGE_BLOCK]} isError />,
    )

    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
    fireEvent.click(container.querySelector('[data-chat-disclosure="true"]')!)
    expect(screen.getByText('Partial capture')).toBeInTheDocument()
  })

  it('says when a returned image is not shown, and shows no text band for it', () => {
    const { container } = render(<ToolResultBlock content={[SVG_BLOCK]} isError={false} />)

    expect(screen.getByText('Images not shown: 1')).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
    expect(container.querySelector('.font-mono')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('keeps a text-only result collapsed until expanded', () => {
    const { container } = render(<ToolResultBlock content="plain output" isError={false} />)

    expect(container.querySelector('[data-tool-result-images]')).toBeNull()
    expect(container.textContent).not.toContain('plain output')
    fireEvent.click(container.querySelector('[data-chat-disclosure="true"]')!)
    expect(container.textContent).toContain('plain output')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('renders nothing, and makes no picture, when it is not standalone', () => {
    const { container } = render(<ToolResultBlock content={[IMAGE_BLOCK]} isError={false} standalone={false} />)

    expect(container).toBeEmptyDOMElement()
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
