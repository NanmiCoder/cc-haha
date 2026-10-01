import '@testing-library/jest-dom'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiGetBlob = vi.hoisted(() => vi.fn())

vi.mock('../../api/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  apiGetBlob,
  getBaseUrl: () => 'http://127.0.0.1:3456',
}))

import { MarkdownRenderer } from './MarkdownRenderer'

const LOCAL = 'http://127.0.0.1:3456/api/filesystem/file?path=%2Ftmp%2Fchart.png'

beforeEach(() => {
  apiGetBlob.mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:http://localhost/chart'), configurable: true, writable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
})

describe('MarkdownRenderer local images', () => {
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
    await Promise.resolve()

    expect(apiGetBlob).not.toHaveBeenCalled()
  })
})
