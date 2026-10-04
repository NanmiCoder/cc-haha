import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchServerImageBlobUrl = vi.hoisted(() => vi.fn())
vi.mock('../../lib/authedImage', () => ({ fetchServerImageBlobUrl }))

import { ApiError } from '../../api/client'
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
    expect(fetchServerImageBlobUrl).toHaveBeenCalledWith('http://127.0.0.1:1/a.png')
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('reports a failure only after the authenticated attempt fails too', async () => {
    fetchServerImageBlobUrl.mockRejectedValue(new Error('403'))
    const onFailure = vi.fn()
    render(<AuthedImage src="http://127.0.0.1:1/a.png" alt="a" onFailure={onFailure} />)

    fireEvent.error(screen.getByRole('img'))

    await waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1))
  })

  // A file the server will not serve is not there to show; anything else is a
  // load that should have worked.
  it.each([
    [404, 'unavailable'],
    [403, 'unavailable'],
    [400, 'unavailable'],
    [413, 'unavailable'],
    [401, 'failed'],
    [500, 'failed'],
  ] as const)('reports HTTP %i from the authenticated attempt as %s', async (status, failure) => {
    fetchServerImageBlobUrl.mockRejectedValue(new ApiError(status, {}))
    const onFailure = vi.fn()
    render(<AuthedImage src="http://127.0.0.1:1/a.png" alt="a" onFailure={onFailure} />)

    fireEvent.error(screen.getByRole('img'))

    await waitFor(() => expect(onFailure).toHaveBeenCalledWith(failure))
  })

  it('reports a dropped connection as a failure, not as a file that is not there', async () => {
    fetchServerImageBlobUrl.mockRejectedValue(new TypeError('Failed to fetch'))
    const onFailure = vi.fn()
    render(<AuthedImage src="http://127.0.0.1:1/a.png" alt="a" onFailure={onFailure} />)

    fireEvent.error(screen.getByRole('img'))

    await waitFor(() => expect(onFailure).toHaveBeenCalledWith('failed'))
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

  it('fetches a user retry directly with the credential instead of reusing a cached broken URL', async () => {
    fetchServerImageBlobUrl.mockResolvedValue('blob:retry')
    render(<AuthedImage src="http://127.0.0.1:1/a.png" alt="a" retryWithCredential />)

    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:retry'))
    expect(fetchServerImageBlobUrl).toHaveBeenCalledTimes(1)
    expect(fetchServerImageBlobUrl).toHaveBeenCalledWith('http://127.0.0.1:1/a.png', true)
  })

  it('ignores duplicate bare errors while authentication is pending and reports a decode failure once', async () => {
    let finish!: (url: string) => void
    fetchServerImageBlobUrl.mockReturnValue(new Promise<string>((resolve) => { finish = resolve }))
    const onFailure = vi.fn()
    render(<AuthedImage src="http://127.0.0.1:1/a.png" alt="a" onFailure={onFailure} />)
    fireEvent.error(screen.getByRole('img'))
    fireEvent.error(screen.getByRole('img'))
    expect(onFailure).not.toHaveBeenCalled()
    finish('blob:invalid')
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:invalid'))
    fireEvent.error(screen.getByRole('img'))
    fireEvent.error(screen.getByRole('img'))
    expect(onFailure).toHaveBeenCalledTimes(1)
    // The server sent the file and it did not decode: there, and broken.
    expect(onFailure).toHaveBeenCalledWith('failed')
  })

  it('discards a late copy after switching sources, even when returning to the original source', async () => {
    let finish!: (url: string) => void
    fetchServerImageBlobUrl.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve }))
      .mockResolvedValueOnce('blob:new-a')
    const { rerender } = render(<AuthedImage src="http://127.0.0.1:1/a.png" alt="a" />)
    fireEvent.error(screen.getByRole('img'))
    rerender(<AuthedImage src="http://127.0.0.1:1/b.png" alt="a" />)
    rerender(<AuthedImage src="http://127.0.0.1:1/a.png" alt="a" />)
    finish('blob:stale-a')
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stale-a'))
    expect(screen.getByRole('img')).toHaveAttribute('src', 'http://127.0.0.1:1/a.png')
    fireEvent.error(screen.getByRole('img'))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:new-a'))
  })
})
