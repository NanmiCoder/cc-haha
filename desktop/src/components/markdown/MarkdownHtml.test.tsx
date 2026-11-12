import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { useSettingsStore } from '@/stores/settingsStore'
import { MarkdownHtml } from './MarkdownHtml'

const fetchServerImageBlobUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/authedImage', () => ({ fetchServerImageBlobUrl }))

beforeEach(() => {
  // A server fault: the load should have worked, so the retryable notice shows.
  fetchServerImageBlobUrl.mockReset().mockRejectedValue(new ApiError(500, { error: 'Internal error' }))
  useSettingsStore.setState({ locale: 'en' })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
})

describe('MarkdownHtml image lifecycle', () => {
  it('keeps prose without images in its original layout', () => {
    const { container } = render(<MarkdownHtml html="<p>Text</p>" />)
    expect(container.firstElementChild?.firstElementChild?.tagName).toBe('P')
  })

  it('preserves image presentation but ignores raw HTML claims to a portal slot', () => {
    const { container } = render(<MarkdownHtml html={'<p><span data-md-image="">text</span><img src="/a.png" alt="a" title="title" width="80" height="40" class="picture"></p>'} />)
    expect(container.querySelectorAll('[data-md-image]')).toHaveLength(1)
    const image = screen.getByRole('img', { name: 'a' })
    expect(image).toHaveAttribute('title', 'title')
    expect(image).toHaveAttribute('width', '80')
    expect(image).toHaveAttribute('height', '40')
    expect(image).toHaveClass('picture')
  })

  it.each([
    ['en', 'Unable to load image', 'Retry image: 图片.png', 'Retry'],
  ] as const)('shows the error, retry, and accessible name in %s', async (locale, title, name, retry) => {
    useSettingsStore.setState({ locale })
    render(<MarkdownHtml html={'<p><img src="/preview-fs/s1/%E5%9B%BE%E7%89%87.png" alt="description"></p>'} />)
    fireEvent.error(screen.getByRole('img'))
    expect(await screen.findByRole('alert')).toHaveTextContent(title)
    expect(screen.getByRole('button', { name })).toHaveTextContent(retry)
  })

  it('names the retry action after the failed image', async () => {
    render(<MarkdownHtml html={'<img src="/broken.png" alt="description">'} />)
    fireEvent.error(screen.getByRole('img'))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load image')
    expect(screen.getByRole('button', { name: 'Retry image: broken.png' })).toBeInTheDocument()
  })

  it('keeps the placeholder when the retry returns a body that cannot decode', async () => {
    fetchServerImageBlobUrl.mockRejectedValueOnce(new ApiError(500, {})).mockResolvedValueOnce('blob:invalid')
    const { container } = render(<MarkdownHtml html={'<img src="/broken.png" alt="description">'} />)
    fireEvent.error(screen.getByRole('img'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: /Retry image/ }))
    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'blob:invalid'))
    fireEvent.error(container.querySelector('img')!)
    expect(screen.getByRole('alert')).toHaveTextContent('broken.png')
    expect(screen.getByRole('button', { name: /Retry image/ })).toBeEnabled()
  })

  describe('an image the server will not serve', () => {
    // A picture the reply embedded that is missing or outside the readable roots
    // is not a fault to retry: like any image that cannot be shown, it falls back
    // to its text alternative instead of a red notice.
    it.each([404, 403])('falls back to its description after HTTP %i', async (status) => {
      fetchServerImageBlobUrl.mockRejectedValue(new ApiError(status, { error: 'refused' }))
      render(<MarkdownHtml html={'<p>Result:<img src="/tmp/cleaned.png" alt="Architecture diagram"></p>'} />)

      fireEvent.error(screen.getByRole('img'))

      expect(await screen.findByText('Architecture diagram')).toBeVisible()
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Retry image/ })).not.toBeInTheDocument()
    })

    it('leaves nothing in place of one without a description', async () => {
      fetchServerImageBlobUrl.mockRejectedValue(new ApiError(404, { error: 'File not found' }))
      const { container } = render(<MarkdownHtml html={'<p>Result:<img src="/tmp/cleaned.png" alt=""></p>'} />)

      fireEvent.error(container.querySelector('img')!)

      await waitFor(() => expect(container.querySelector('img')).not.toBeVisible())
      expect(container).toHaveTextContent(/^Result:$/)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('settles on the description when a retry finds the file gone', async () => {
      fetchServerImageBlobUrl.mockRejectedValueOnce(new ApiError(500, {}))
        .mockRejectedValueOnce(new ApiError(404, { error: 'File not found' }))
      render(<MarkdownHtml html={'<img src="/tmp/chart.png" alt="chart">'} />)
      fireEvent.error(screen.getByRole('img'))
      fireEvent.click(await screen.findByRole('button', { name: /Retry image/ }))

      expect(await screen.findByText('chart')).toBeVisible()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('frees the old image copy and resets failures when the Markdown changes', async () => {
    fetchServerImageBlobUrl.mockResolvedValue('blob:old')
    const { rerender } = render(<MarkdownHtml html={'<img src="/a.png" alt="a">'} />)
    fireEvent.error(screen.getByRole('img'))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:old'))
    fireEvent.error(screen.getByRole('img'))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    rerender(<MarkdownHtml html={'<p>new</p><img src="/b.png" alt="b">'} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', '/b.png')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old')
  })
})
