import { describe, expect, test } from 'bun:test'
import { createToolImageLoader, inlineToolImageUri } from './toolImages'
import type { ToolImageVariant } from './client'

const ref = (n: number) => ({ mimeType: 'image/png', url: `/api/sessions/s/tool-images/toolu_${n}/0` })

function fakeClient(fail = new Set<string>()) {
  const calls: string[] = []
  const gates = new Map<string, () => void>()
  return {
    calls,
    release: (key: string) => gates.get(key)?.(),
    client: {
      image: (url: string, variant: ToolImageVariant) => {
        const key = `${url}?${variant}`
        calls.push(key)
        return new Promise<string>((resolve, reject) => {
          gates.set(key, () => fail.has(key) ? reject(new Error('offline')) : resolve(`data:image/webp;base64,${key}`))
        })
      },
    },
  }
}

describe('tool image loader', () => {
  test('draws inline images from older computers without a request', async () => {
    const fake = fakeClient()
    const loader = createToolImageLoader(fake.client)
    const inline = { mimeType: 'image/png', data: 'aGk=' }
    expect(inlineToolImageUri(inline)).toBe('data:image/png;base64,aGk=')
    expect(loader.peek(inline, 'thumb')).toBe('data:image/png;base64,aGk=')
    await expect(loader.load(inline, 'full')).resolves.toBe('data:image/png;base64,aGk=')
    expect(fake.calls).toEqual([])
  })

  test('shares one download per image and variant and keeps the result', async () => {
    const fake = fakeClient()
    const loader = createToolImageLoader(fake.client)
    const a = loader.load(ref(1), 'thumb')
    const b = loader.load(ref(1), 'thumb')
    expect(fake.calls).toEqual(['/api/sessions/s/tool-images/toolu_1/0?thumb'])
    fake.release('/api/sessions/s/tool-images/toolu_1/0?thumb')
    expect(await a).toBe(await b)
    expect(loader.peek(ref(1), 'thumb')).toBe(await a)
    expect(loader.peek(ref(1), 'full')).toBeUndefined()
    await loader.load(ref(1), 'thumb')
    expect(fake.calls).toHaveLength(1)
  })

  test('a failed download is retried on the next request', async () => {
    const key = '/api/sessions/s/tool-images/toolu_2/0?thumb'
    const fake = fakeClient(new Set([key]))
    const loader = createToolImageLoader(fake.client)
    const first = loader.load(ref(2), 'thumb')
    fake.release(key)
    await expect(first).rejects.toThrow('offline')
    expect(loader.peek(ref(2), 'thumb')).toBeUndefined()
    void loader.load(ref(2), 'thumb').catch(() => {})
    expect(fake.calls).toEqual([key, key])
  })

  test('keeps only the most recent originals', async () => {
    const fake = fakeClient()
    const loader = createToolImageLoader(fake.client)
    for (const n of [1, 2, 3, 4]) {
      const loading = loader.load(ref(n), 'full')
      fake.release(`/api/sessions/s/tool-images/toolu_${n}/0?full`)
      await loading
    }
    expect(loader.peek(ref(1), 'full')).toBeUndefined()
    expect(loader.peek(ref(4), 'full')).toBeDefined()
    expect(loader.peek(ref(2), 'full')).toBeDefined()
  })
})
