import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiGetBlob = vi.hoisted(() => vi.fn())

vi.mock('../../api/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  apiGetBlob,
  getBaseUrl: () => 'http://127.0.0.1:3456',
}))

import { ApiError } from '../../api/client'
import { MarkdownRenderer } from './MarkdownRenderer'
import { useSettingsStore } from '@/stores/settingsStore'

const LOCAL = 'http://127.0.0.1:3456/api/filesystem/file?path=%2Ftmp%2Fchart.png'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  apiGetBlob.mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:http://localhost/chart'), configurable: true, writable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
})

describe('MarkdownRenderer local images', () => {
  // A missing or unreadable picture is no fault, and a red notice for each one —
  // every embed of a file since cleaned out of /tmp — was noise. It falls back to
  // its description, as an image that cannot be shown does.
  it.each([404, 403])('shows the description instead of an error after HTTP %s', async (status) => {
    apiGetBlob.mockRejectedValue(new ApiError(status, { error: 'refused' }))
    const { container } = render(
      <MarkdownRenderer content="![description](missing.png)" resolveImageSrc={() => LOCAL.replace('chart.png', 'missing.png')} />,
    )
    fireEvent.error(container.querySelector('img')!)

    expect(await screen.findByText('description')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  // QA-002: a terminal image error used to leave only the browser's broken icon.
  it('keeps a named error placeholder after a server fault and lets a retry recover', async () => {
    apiGetBlob.mockRejectedValueOnce(new ApiError(500, { error: 'Internal error' }))
      .mockRejectedValueOnce(new ApiError(500, { error: 'Internal error' }))
      .mockResolvedValueOnce(new Blob(['png'], { type: 'image/png' }))
    const { container } = render(
      <MarkdownRenderer content="![description](missing.png)" resolveImageSrc={() => LOCAL.replace('chart.png', 'missing.png')} />,
    )
    fireEvent.error(container.querySelector('img')!)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Unable to load image')
    expect(alert).toHaveTextContent('missing.png')
    expect(alert).toHaveTextContent('The file may be damaged, or the local server did not respond.')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Retry image: missing.png' })
    expect(retry).toHaveAttribute('aria-describedby')
    expect(retry.className).toContain('focus-visible:ring-2')
    fireEvent.click(retry)
    await waitFor(() => expect(apiGetBlob).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('alert')).toHaveTextContent('missing.png')
    await waitFor(() => expect(retry).toBeEnabled())

    fireEvent.click(retry)
    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'blob:http://localhost/chart'))
    // A successful HTTP response is insufficient: keep the notice until decode succeeds.
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.load(container.querySelector('img')!)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'description' })).toBeVisible()
  })

  it('keeps failures local to one image and excludes it from the viewer', async () => {
    apiGetBlob.mockRejectedValue(new ApiError(500, { error: 'Internal error' }))
    const onImageClick = vi.fn()
    const { container } = render(
      <MarkdownRenderer content="![missing](missing.png)\n\n![valid](chart.png)" resolveImageSrc={(src) => LOCAL.replace('chart.png', src)} onImageClick={onImageClick} />,
    )
    fireEvent.error(container.querySelector('img')!)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('img', { name: 'valid' }))
    expect(onImageClick).toHaveBeenCalledWith({ images: [{ src: LOCAL, alt: 'valid' }], index: 0 })
  })

  it('does not navigate a surrounding link when retry is clicked', async () => {
    apiGetBlob.mockRejectedValue(new ApiError(500, { error: 'Internal error' }))
    const onLinkClick = vi.fn()
    const { container } = render(
      <MarkdownRenderer content="[![missing](missing.png)](https://example.com)" resolveImageSrc={() => LOCAL} onLinkClick={onLinkClick} />,
    )
    fireEvent.error(container.querySelector('img')!)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: /Retry image/ }))
    await waitFor(() => expect(apiGetBlob).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry image/ })).toBeEnabled())
    expect(onLinkClick).not.toHaveBeenCalled()
  })

  it('does not reuse a failure from another renderer with the same parsed Markdown', async () => {
    apiGetBlob.mockRejectedValue(new ApiError(500, { error: 'Internal error' }))
    const content = '![missing](missing.png)'
    const { container } = render(<><MarkdownRenderer content={content} resolveImageSrc={() => LOCAL} /><MarkdownRenderer content={content} resolveImageSrc={() => LOCAL} /></>)
    const prose = container.querySelectorAll<HTMLElement>('.markdown-prose')
    fireEvent.error(prose[0]!.querySelector('img')!)
    await within(prose[0]!).findByRole('alert')
    expect(within(prose[1]!).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(prose[1]!).getByRole('img')).toBeInTheDocument()
  })

  it('retries a refused local image with the app credential', async () => {
    const { container } = render(
      <MarkdownRenderer content="![chart](chart.png)" resolveImageSrc={() => LOCAL} />,
    )
    const image = container.querySelector('img')!
    expect(image).toHaveAttribute('src', LOCAL)

    fireEvent.error(image)

    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'blob:http://localhost/chart'))
    expect(apiGetBlob).toHaveBeenCalledWith('/api/filesystem/file?path=%2Ftmp%2Fchart.png')
  })

  it('also covers a document with code blocks, which render in separate parts', async () => {
    const { container } = render(
      <MarkdownRenderer content={'![chart](chart.png)\n\n```ts\nconst a = 1\n```'} resolveImageSrc={() => LOCAL} />,
    )

    fireEvent.error(container.querySelector('img')!)

    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'blob:http://localhost/chart'))
  })

  it('never sends the credential for a remote image', async () => {
    const { container } = render(
      <MarkdownRenderer content="![cat](https://example.com/cat.png)" resolveImageSrc={(src) => src} />,
    )

    fireEvent.error(container.querySelector('img')!)
    await screen.findByRole('alert')

    expect(apiGetBlob).not.toHaveBeenCalled()
  })
})
