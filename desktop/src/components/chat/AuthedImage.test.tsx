import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchServerImageBlobUrl = vi.hoisted(() => vi.fn())
vi.mock('../../lib/authedImage', () => ({ fetchServerImageBlobUrl }))

import { AuthedImage } from './AuthedImage'

beforeEach(() => {
  fetchServerImageBlobUrl.mockReset()
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
})

describe('AuthedImage', () => {
  it('shows the bare URL until it fails', () => {
    render(<AuthedImage src="http://127.0.0.1:1/a.png" alt="a" />)

    expect(screen.getByRole('img')).toHaveAttribute('src', 'http://127.0.0.1:1/a.png')
    expect(fetchServerImageBlobUrl).not.toHaveBeenCalled()
  })

  it('swaps in the authenticated copy without reporting a failure', async () => {
    fetchServerImageBlobUrl.mockResolvedValue('blob:x')
    const onFailure = vi.fn()
    render(<AuthedImage src="http://127.0.0.1:1/a.png" alt="a" onFailure={onFailure} />)

    fireEvent.error(screen.getByRole('img'))

    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:x'))
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('reports a failure only after the authenticated attempt fails too', async () => {
    fetchServerImageBlobUrl.mockRejectedValue(new Error('403'))
    const onFailure = vi.fn()
    render(<AuthedImage src="http://127.0.0.1:1/a.png" alt="a" onFailure={onFailure} />)

    fireEvent.error(screen.getByRole('img'))

    await waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1))
  })

  it('does not apply a result that arrives after the image is gone, and frees it', async () => {
    let finish!: (url: string) => void
    fetchServerImageBlobUrl.mockReturnValue(new Promise<string>((resolve) => { finish = resolve }))
    const { unmount } = render(<AuthedImage src="http://127.0.0.1:1/a.png" alt="a" />)
    fireEvent.error(screen.getByRole('img'))

    unmount()
    finish('blob:late')

    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late'))
  })

  it('treats a new src as a new image: it gets its own retry', async () => {
    fetchServerImageBlobUrl.mockResolvedValueOnce('blob:one').mockResolvedValueOnce('blob:two')
    const { rerender } = render(<AuthedImage src="http://127.0.0.1:1/one.png" alt="a" />)
    fireEvent.error(screen.getByRole('img'))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:one'))

    rerender(<AuthedImage src="http://127.0.0.1:1/two.png" alt="a" />)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'http://127.0.0.1:1/two.png')
    fireEvent.error(screen.getByRole('img'))

    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:two'))
  })
})
