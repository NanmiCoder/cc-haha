import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiGetBlob = vi.hoisted(() => vi.fn())

vi.mock('../api/client', () => ({
  apiGetBlob,
  getBaseUrl: () => 'http://127.0.0.1:3456',
}))

import { attachAuthedImageFallback, fetchServerImageBlobUrl } from './authedImage'

beforeEach(() => {
  apiGetBlob.mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:http://localhost/x'), configurable: true, writable: true })
})

afterEach(() => {
  Reflect.deleteProperty(URL, 'createObjectURL')
})

describe('fetchServerImageBlobUrl', () => {
  it('fetches a local-server image through the credentialed client and returns an object URL', async () => {
    const src = `http://127.0.0.1:3456/api/filesystem/file?path=${encodeURIComponent('/tmp/fti work/chart.png')}`

    await expect(fetchServerImageBlobUrl(src)).resolves.toBe('blob:http://localhost/x')

    // Path and query only: the client prepends its own base URL and credential.
    expect(apiGetBlob).toHaveBeenCalledWith(`/api/filesystem/file?path=${encodeURIComponent('/tmp/fti work/chart.png')}`)
  })

  it('serves a session preview URL the same way', async () => {
    await fetchServerImageBlobUrl('http://127.0.0.1:3456/preview-fs/s1/out/frame.png')

    expect(apiGetBlob).toHaveBeenCalledWith('/preview-fs/s1/out/frame.png')
  })

  it.each([
    'https://example.com/cat.png',
    'http://127.0.0.1:9999/api/filesystem/file?path=%2Fetc%2Fhosts',
    'http://localhost:3456/api/filesystem/file?path=%2Ftmp%2Fa.png',
  ])('never sends the credential to another origin (%s)', async (src) => {
    await expect(fetchServerImageBlobUrl(src)).rejects.toThrow('Not a local-server image URL')

    expect(apiGetBlob).not.toHaveBeenCalled()
  })

  it('propagates a refusal so the caller can show the failure notice', async () => {
    apiGetBlob.mockRejectedValue(new Error('403'))

    await expect(fetchServerImageBlobUrl('http://127.0.0.1:3456/api/filesystem/file?path=%2Ftmp%2Fa.png')).rejects.toThrow('403')
  })
})

describe('attachAuthedImageFallback', () => {
  const localSrc = 'http://127.0.0.1:3456/api/filesystem/file?path=%2Ftmp%2Fa.png'

  function mount(src: string) {
    const container = document.createElement('div')
    container.innerHTML = `<p><img alt="a" src="${src}"></p>`
    document.body.appendChild(container)
    const detach = attachAuthedImageFallback(container)
    return { container, image: container.querySelector('img')!, detach }
  }

  beforeEach(() => {
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
  })

  it('swaps a refused local image for an authenticated copy', async () => {
    const { image, detach } = mount(localSrc)

    image.dispatchEvent(new Event('error'))

    await vi.waitFor(() => expect(image.getAttribute('src')).toBe('blob:http://localhost/x'))
    detach()
  })

  it('retries each image only once, so a broken body does not loop', async () => {
    const { image, detach } = mount(localSrc)
    image.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(image.getAttribute('src')).toBe('blob:http://localhost/x'))

    image.dispatchEvent(new Event('error'))

    expect(apiGetBlob).toHaveBeenCalledTimes(1)
    detach()
  })

  it.each(['https://example.com/cat.png', 'data:image/png;base64,AAAA'])('leaves %s alone', async (src) => {
    const { image, detach } = mount(src)

    image.dispatchEvent(new Event('error'))
    await Promise.resolve()

    expect(apiGetBlob).not.toHaveBeenCalled()
    expect(image.getAttribute('src')).toBe(src)
    detach()
  })

  it('frees its object URLs and stops listening once detached', async () => {
    const { image, detach } = mount(localSrc)
    image.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(image.getAttribute('src')).toBe('blob:http://localhost/x'))

    detach()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/x')
    const other = document.createElement('img')
    other.setAttribute('src', localSrc)
    image.parentElement!.appendChild(other)
    other.dispatchEvent(new Event('error'))
    expect(apiGetBlob).toHaveBeenCalledTimes(1)
  })
})
