import '@testing-library/jest-dom'
import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolResultImage } from '@/lib/toolResultContent'
import type { GalleryImage } from '@/components/chat/conversationImageGallery'
import { useSettingsStore } from '@/stores/settingsStore'
import { ToolResultImages } from './ToolResultImages'

type GalleryProps = {
  open: boolean
  images: GalleryImage[]
  activeIndex: number
  onClose: () => void
  onSelect: (index: number) => void
}

// The lightbox has its own tests. Here it is a probe: what it was handed, and a
// way to drive the callbacks it is handed.
const lightbox = vi.hoisted(() => ({ latest: null as null | GalleryProps }))

vi.mock('./ImageGalleryModal', () => ({
  ImageGalleryModal: (props: GalleryProps) => {
    lightbox.latest = props
    return (
      <div role="dialog" aria-label={props.images[props.activeIndex]?.name}>
        <span data-testid="lightbox-position">{props.activeIndex + 1} / {props.images.length}</span>
        <button type="button" onClick={() => props.onSelect((props.activeIndex + 1) % props.images.length)}>
          lightbox next
        </button>
        <button type="button" onClick={props.onClose}>lightbox close</button>
      </div>
    )
  },
}))

const FIRST: ToolResultImage = { mediaType: 'image/png', data: Buffer.from('first picture bytes').toString('base64') }
const SECOND: ToolResultImage = { mediaType: 'image/jpeg', data: Buffer.from('second picture bytes').toString('base64') }
const THIRD: ToolResultImage = { mediaType: 'image/webp', data: Buffer.from('third picture bytes').toString('base64') }

let counter = 0
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
const blobs = new Map<string, Blob>()
const savedUrlMembers = {
  create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
  revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
}

function defineUrlMember(name: 'createObjectURL' | 'revokeObjectURL', value: unknown) {
  Object.defineProperty(URL, name, { configurable: true, writable: true, value })
}

function restoreUrlMember(name: 'createObjectURL' | 'revokeObjectURL', saved: PropertyDescriptor | undefined) {
  if (saved) Object.defineProperty(URL, name, saved)
  else delete (URL as unknown as Record<string, unknown>)[name]
}

beforeEach(() => {
  counter = 0
  blobs.clear()
  lightbox.latest = null
  useSettingsStore.setState({ locale: 'en' })
  createObjectURL = vi.fn((blob: Blob) => {
    counter += 1
    const url = `blob:test-${counter}`
    blobs.set(url, blob)
    return url
  })
  revokeObjectURL = vi.fn()
  defineUrlMember('createObjectURL', createObjectURL)
  defineUrlMember('revokeObjectURL', revokeObjectURL)
})

afterEach(() => {
  cleanup()
  restoreUrlMember('createObjectURL', savedUrlMembers.create)
  restoreUrlMember('revokeObjectURL', savedUrlMembers.revoke)
  vi.restoreAllMocks()
})

function created(): string[] {
  return createObjectURL.mock.results.map((result) => result.value as string)
}

function revoked(): string[] {
  return revokeObjectURL.mock.calls.map((call) => call[0] as string)
}

function liveUrls(): string[] {
  const gone = new Set(revoked())
  return created().filter((url) => !gone.has(url))
}

function thumbnailSources(container: HTMLElement): string[] {
  return [...container.querySelectorAll('img')].map((image) => image.getAttribute('src') ?? '')
}

function readBytes(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)])
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

describe('ToolResultImages · thumbnails', () => {
  it('renders one named thumbnail button per image, showing the object URL', () => {
    const { container } = render(<ToolResultImages images={[FIRST, SECOND]} toolName="Read" />)

    const first = screen.getByRole('button', { name: 'Open image 1 of 2' })
    const second = screen.getByRole('button', { name: 'Open image 2 of 2' })
    expect(first).toHaveAttribute('type', 'button')
    expect(within(first).getByRole('img', { name: 'Image 1 of 2' })).toHaveAttribute('src', 'blob:test-1')
    expect(within(second).getByRole('img', { name: 'Image 2 of 2' })).toHaveAttribute('src', 'blob:test-2')
    expect(thumbnailSources(container)).toEqual(['blob:test-1', 'blob:test-2'])
  })

  it('names the strip after the tool, or generically when there is none', () => {
    const { rerender } = render(<ToolResultImages images={[FIRST]} toolName="mcp__shots__take" />)
    expect(screen.getByRole('group', { name: 'mcp__shots__take result' })).toBeInTheDocument()

    rerender(<ToolResultImages images={[FIRST]} />)
    expect(screen.getByRole('group', { name: 'Tool result' })).toBeInTheDocument()
  })

  it('localizes its labels', () => {
    useSettingsStore.setState({ locale: 'zh' })
    render(<ToolResultImages images={[FIRST, SECOND]} />)

    expect(screen.getByRole('button', { name: '打开图片 2/2' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '工具结果' })).toBeInTheDocument()
  })

  it('decodes each image into a Blob with its own type and bytes', async () => {
    render(<ToolResultImages images={[FIRST, SECOND]} />)

    expect(createObjectURL).toHaveBeenCalledTimes(2)
    const firstBlob = blobs.get('blob:test-1')!
    const secondBlob = blobs.get('blob:test-2')!
    expect(firstBlob.type).toBe('image/png')
    expect(secondBlob.type).toBe('image/jpeg')
    expect(await readBytes(firstBlob)).toEqual([...Buffer.from('first picture bytes')])
    expect(await readBytes(secondBlob)).toEqual([...Buffer.from('second picture bytes')])
  })

  it('does not touch the object URL API while rendering', () => {
    // A server or a discarded render has no effects; creating URLs in the render
    // body would leak one per discarded render because nothing revokes them.
    const markup = renderToString(<ToolResultImages images={[FIRST, SECOND]} />)

    expect(createObjectURL).not.toHaveBeenCalled()
    // Until the URLs exist the strip only reserves its height.
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('<img')
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(2)
  })

  it('renders nothing for no images and nothing omitted', () => {
    const { container } = render(<ToolResultImages images={[]} />)

    expect(container).toBeEmptyDOMElement()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('applies the spacing its chrome asks for', () => {
    render(<ToolResultImages images={[FIRST]} className="px-4 pb-3" />)

    expect(screen.getByRole('group')).toHaveClass('px-4', 'pb-3')
  })
})

describe('ToolResultImages · object URL lifecycle', () => {
  it('revokes exactly the URLs it made when unmounted', () => {
    const { unmount } = render(<ToolResultImages images={[FIRST, SECOND]} />)
    expect(revoked()).toEqual([])

    unmount()

    expect([...revoked()].sort()).toEqual(['blob:test-1', 'blob:test-2'])
    expect(liveUrls()).toEqual([])
  })

  it('revokes the old URLs and makes new ones when the images change', () => {
    const { container, rerender } = render(<ToolResultImages images={[FIRST, SECOND]} />)

    rerender(<ToolResultImages images={[THIRD]} />)

    expect([...revoked()].sort()).toEqual(['blob:test-1', 'blob:test-2'])
    expect(created()).toEqual(['blob:test-1', 'blob:test-2', 'blob:test-3'])
    expect(thumbnailSources(container)).toEqual(['blob:test-3'])
    expect(liveUrls()).toEqual(['blob:test-3'])
  })

  it('never leaves a thumbnail pointing at a URL at the moment that URL is revoked', () => {
    // The cleanup runs right after the commit that switches to the new images. If
    // that commit still shows the old URLs, an <img> is left holding a revoked
    // one, and one that mounts in that state fails to load and is written off.
    const { container, rerender } = render(<ToolResultImages images={[FIRST, SECOND]} />)
    const stillShown: string[] = []
    revokeObjectURL.mockImplementation((url: string) => {
      if (thumbnailSources(container).includes(url)) stillShown.push(url)
    })

    rerender(<ToolResultImages images={[THIRD]} />)

    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(stillShown).toEqual([])
  })

  it('does not decode again for an equal array in a new object', () => {
    // History reloads and wrapper rebuilds hand over new arrays with the same
    // pictures; each swap would decode megabytes again and flash every thumbnail.
    const { container, rerender } = render(<ToolResultImages images={[FIRST, SECOND]} />)

    rerender(<ToolResultImages images={[{ ...FIRST }, { ...SECOND }]} />)

    expect(createObjectURL).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(thumbnailSources(container)).toEqual(['blob:test-1', 'blob:test-2'])
  })

  it('does decode again when a picture keeps its length but changes its content', () => {
    const { container, rerender } = render(<ToolResultImages images={[FIRST]} />)
    const sameLength = { ...FIRST, data: `Y${FIRST.data.slice(1)}` }
    expect(sameLength.data).toHaveLength(FIRST.data.length)
    expect(sameLength.data).not.toBe(FIRST.data)

    rerender(<ToolResultImages images={[sameLength]} />)

    expect(revoked()).toEqual(['blob:test-1'])
    expect(thumbnailSources(container)).toEqual(['blob:test-2'])
  })

  it('does not decode again when only the surrounding props change', () => {
    const { rerender } = render(<ToolResultImages images={[FIRST]} className="px-4" />)

    rerender(<ToolResultImages images={[FIRST]} className="px-3" originalPath="/tmp/a.png" toolName="Read" omitted={2} />)

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('leaves no URL behind under StrictMode double mounting', () => {
    const { container, unmount } = render(
      <StrictMode>
        <ToolResultImages images={[FIRST, SECOND]} />
      </StrictMode>,
    )

    // Two mounts of the effect made four URLs; the first pair was released by
    // the simulated unmount, and what the thumbnails show is what is still live.
    expect(created()).toHaveLength(4)
    expect(liveUrls()).toHaveLength(2)
    expect(thumbnailSources(container).sort()).toEqual([...liveUrls()].sort())

    unmount()

    expect(liveUrls()).toEqual([])
  })

  it('revokes when the strip empties out, not only when it unmounts', () => {
    const { container, rerender } = render(<ToolResultImages images={[FIRST]} />)

    rerender(<ToolResultImages images={[]} />)

    expect(revoked()).toEqual(['blob:test-1'])
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ToolResultImages · lightbox', () => {
  it('opens on the clicked thumbnail, with only object URLs', () => {
    render(<ToolResultImages images={[FIRST, SECOND]} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open image 2 of 2' }))

    expect(screen.getByRole('dialog', { name: 'Image 2 of 2' })).toBeInTheDocument()
    expect(screen.getByTestId('lightbox-position')).toHaveTextContent('2 / 2')
    expect(lightbox.latest?.open).toBe(true)
    expect(lightbox.latest?.images.map((image) => image.src)).toEqual(['blob:test-1', 'blob:test-2'])
  })

  it('follows the lightbox when it moves to another picture', () => {
    render(<ToolResultImages images={[FIRST, SECOND]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open image 1 of 2' }))

    fireEvent.click(screen.getByRole('button', { name: 'lightbox next' }))

    expect(screen.getByRole('dialog', { name: 'Image 2 of 2' })).toBeInTheDocument()
    expect(lightbox.latest?.activeIndex).toBe(1)
  })

  it('closes when the lightbox asks to', () => {
    render(<ToolResultImages images={[FIRST]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open image 1 of 1' }))

    fireEvent.click(screen.getByRole('button', { name: 'lightbox close' }))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes a lightbox whose picture is replaced instead of showing another one', () => {
    const { rerender } = render(<ToolResultImages images={[FIRST]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open image 1 of 1' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    rerender(<ToolResultImages images={[THIRD]} />)

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  describe('handing the original file to the lightbox', () => {
    it.each([
      ['a POSIX path', '/Users/me/pic.png', 'pic.png'],
      ['a Windows path', 'C:\\Users\\me\\pic.png', 'pic.png'],
      ['a home-relative path', '~/Pictures/pic.png', 'pic.png'],
    ])('passes %s as the image path and names the image after the file', (_label, originalPath, name) => {
      render(<ToolResultImages images={[FIRST, SECOND]} originalPath={originalPath} />)

      fireEvent.click(screen.getByRole('button', { name: 'Open image 1 of 2' }))

      expect(lightbox.latest?.images).toEqual([
        { src: 'blob:test-1', name, path: originalPath, inline: FIRST },
        { src: 'blob:test-2', name, path: originalPath, inline: SECOND },
      ])
      expect(screen.getByRole('dialog', { name })).toBeInTheDocument()
    })

    it('names the image after a relative path but offers no original to open', () => {
      render(<ToolResultImages images={[FIRST]} originalPath="shots/pic.png" />)

      fireEvent.click(screen.getByRole('button', { name: 'Open image 1 of 1' }))

      expect(lightbox.latest?.images).toEqual([{ src: 'blob:test-1', name: 'pic.png', inline: FIRST }])
      expect(lightbox.latest?.images[0]).not.toHaveProperty('path')
    })

    it('has no original for pictures no file produced (screenshots, MCP tools)', () => {
      render(<ToolResultImages images={[FIRST]} toolName="mcp__shots__take" />)

      fireEvent.click(screen.getByRole('button', { name: 'Open image 1 of 1' }))

      expect(lightbox.latest?.images).toEqual([{ src: 'blob:test-1', name: 'Image 1 of 1', inline: FIRST }])
      expect(lightbox.latest?.images[0]).not.toHaveProperty('path')
    })
  })
})

describe('ToolResultImages · pictures that cannot be shown', () => {
  it('hides a thumbnail whose image fails to load and keeps the others', () => {
    const { container } = render(<ToolResultImages images={[FIRST, SECOND, THIRD]} />)

    fireEvent.error(within(screen.getByRole('button', { name: 'Open image 2 of 3' })).getByRole('img'))

    expect(screen.queryByRole('button', { name: 'Open image 2 of 3' })).toBeNull()
    expect(thumbnailSources(container)).toEqual(['blob:test-1', 'blob:test-3'])
    // The survivors keep their place in the tool result's own numbering.
    expect(screen.getByRole('button', { name: 'Open image 3 of 3' })).toBeInTheDocument()
  })

  it('leaves a hidden thumbnail out of the lightbox', () => {
    render(<ToolResultImages images={[FIRST, SECOND, THIRD]} />)
    fireEvent.error(within(screen.getByRole('button', { name: 'Open image 1 of 3' })).getByRole('img'))

    fireEvent.click(screen.getByRole('button', { name: 'Open image 3 of 3' }))

    expect(lightbox.latest?.images.map((image) => image.src)).toEqual(['blob:test-2', 'blob:test-3'])
    expect(lightbox.latest?.activeIndex).toBe(1)
    expect(screen.getByTestId('lightbox-position')).toHaveTextContent('2 / 2')
  })

  it('renders nothing once every thumbnail has failed', () => {
    const { container } = render(<ToolResultImages images={[FIRST, SECOND]} />)

    for (const image of screen.getAllByRole('img')) fireEvent.error(image)

    expect(container).toBeEmptyDOMElement()
  })

  it('shows a fresh thumbnail for new images after an earlier one failed', () => {
    const { container, rerender } = render(<ToolResultImages images={[FIRST]} />)
    fireEvent.error(screen.getByRole('img'))
    expect(container).toBeEmptyDOMElement()

    rerender(<ToolResultImages images={[SECOND]} />)

    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
  })

  it('drops an image that will not decode without a crash or a console error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const undecodable: ToolResultImage = { mediaType: 'image/png', data: 'Q' }

    const { container } = render(<ToolResultImages images={[undecodable, FIRST]} />)

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Open image 1 of 2' })).toBeNull()
    expect(within(screen.getByRole('button', { name: 'Open image 2 of 2' })).getByRole('img')).toHaveAttribute('src', 'blob:test-1')
    expect(thumbnailSources(container)).toEqual(['blob:test-1'])
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('renders nothing when every image will not decode', () => {
    const { container } = render(<ToolResultImages images={[{ mediaType: 'image/png', data: 'Q' }]} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing, without throwing, where object URLs do not exist', () => {
    delete (URL as unknown as Record<string, unknown>).createObjectURL
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL

    expect(() => render(<ToolResultImages images={[FIRST]} />)).not.toThrow()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('drops an image whose object URL cannot be created', () => {
    createObjectURL.mockImplementationOnce(() => {
      throw new Error('quota')
    })

    render(<ToolResultImages images={[FIRST, SECOND]} />)

    expect(screen.queryByRole('button', { name: 'Open image 1 of 2' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open image 2 of 2' })).toBeInTheDocument()
  })
})

describe('ToolResultImages · omitted images', () => {
  it('says how many images were not shown, next to the ones that were', () => {
    render(<ToolResultImages images={[FIRST]} omitted={3} />)

    expect(screen.getByText('Images not shown: 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open image 1 of 1' })).toBeInTheDocument()
  })

  it('still says so when none could be shown', () => {
    render(<ToolResultImages images={[]} omitted={1} />)

    expect(screen.getByText('Images not shown: 1')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('says nothing when nothing was left out', () => {
    render(<ToolResultImages images={[FIRST]} omitted={0} />)

    expect(screen.queryByText(/not shown/)).toBeNull()
  })

  it('localizes the note', () => {
    useSettingsStore.setState({ locale: 'zh' })
    render(<ToolResultImages images={[]} omitted={2} />)

    expect(screen.getByText('另有 2 张图片未显示')).toBeInTheDocument()
  })
})
