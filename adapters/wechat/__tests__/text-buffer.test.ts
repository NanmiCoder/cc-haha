import { afterEach, describe, expect, it } from 'bun:test'
import { WechatTextBuffer } from '../text-buffer.js'

const buffers: WechatTextBuffer[] = []
function buffer(stage: ConstructorParameters<typeof WechatTextBuffer>[0], options: ConstructorParameters<typeof WechatTextBuffer>[1] = {}) {
  const result = new WechatTextBuffer(stage, { intervalMs: 60_000, charThreshold: 1_000_000, ...options })
  buffers.push(result)
  return result
}
afterEach(() => { for (const item of buffers.splice(0)) item.dispose() })

describe('WeChat text ownership buffer', () => {
  it('preserves exact unstaged text on disk failure and retries on explicit completion', async () => {
    let available = false
    const staged: string[] = []
    const sent: string[] = []
    const errors: string[] = []
    const item = buffer(text => {
      if (!available) throw new Error('fixture disk full')
      staged.push(text)
      return async () => { sent.push(text) }
    }, { onError: (_error, phase) => { errors.push(phase) } })
    item.append('完整文字')
    await expect(item.complete()).rejects.toThrow('fixture disk full')
    expect(staged).toEqual([])
    available = true
    await item.complete()
    await item.complete()
    expect(staged).toEqual(['完整文字'])
    expect(sent).toEqual(['完整文字'])
    expect(errors).toEqual(['stage'])
  })

  it('includes later deltas when retrying a failed stage', async () => {
    let available = false
    const sent: string[] = []
    const item = buffer(text => {
      if (!available) throw new Error('fixture unavailable')
      return async () => { sent.push(text) }
    })
    item.append('first ')
    await expect(item.complete()).rejects.toThrow('fixture unavailable')
    item.append('second')
    available = true
    await item.complete()
    expect(sent).toEqual(['first second'])
  })

  it('never restages or resends a journalled chunk after unknown network delivery', async () => {
    const staged: string[] = []
    let sends = 0
    const phases: string[] = []
    const item = buffer(text => {
      staged.push(text)
      return async () => { sends++; throw new Error('fixture response lost') }
    }, { onError: (_error, phase) => { phases.push(phase) } })
    item.append('possibly received')
    await item.complete()
    await item.complete()
    expect(staged).toEqual(['possibly received'])
    expect(sends).toBe(1)
    expect(phases).toEqual(['send'])
  })

  it('waits for active send and journals later deltas before complete resolves', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const staged: string[] = []
    const sent: string[] = []
    const item = buffer(text => {
      staged.push(text)
      return async () => { if (text === 'first') await pending; sent.push(text) }
    })
    item.append('first')
    const initial = item.complete()
    item.append('second')
    let completed = false
    const final = item.complete().then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(staged).toEqual(['first'])
    release()
    await Promise.all([initial, final])
    expect(staged).toEqual(['first', 'second'])
    expect(sent).toEqual(['first', 'second'])
    expect(completed).toBe(true)
  })

  it('retains a tail whose staging fails after an active send completes', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let secondAvailable = false
    const staged: string[] = []
    const item = buffer(text => {
      if (text === 'second' && !secondAvailable) throw new Error('fixture capacity exhausted')
      staged.push(text)
      return async () => { if (text === 'first') await pending }
    })
    item.append('first')
    const initial = item.complete()
    item.append('second')
    const final = item.complete()
    const failures = Promise.allSettled([initial, final])
    release()
    const results = await failures
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect((results[0] as PromiseRejectedResult).reason.message).toBe('fixture capacity exhausted')
    secondAvailable = true
    await item.complete()
    expect(staged).toEqual(['first', 'second'])
  })

  it('reset drops only unstaged text and never replays the prior in-flight chunk', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const staged: string[] = []
    const item = buffer(text => {
      staged.push(text)
      return async () => { await pending }
    })
    item.append('already journalled')
    const active = item.complete()
    item.append('cancel this')
    item.reset()
    release()
    await active
    await item.complete()
    expect(staged).toEqual(['already journalled'])
  })

  it('bounds unstaged UTF-8 bytes and preserves the previous text on overflow', async () => {
    const staged: string[] = []
    const phases: string[] = []
    const item = buffer(text => { staged.push(text); return async () => {} }, {
      maxBytes: 6,
      onError: (_error, phase) => { phases.push(phase) },
    })
    item.append('你好')
    expect(() => item.append('!')).toThrow('buffer is full')
    await item.complete()
    expect(staged).toEqual(['你好'])
    expect(phases).toEqual(['overflow'])
  })

  it('flushes threshold text and contains reporting callback failures', async () => {
    const staged: string[] = []
    const item = buffer(text => {
      staged.push(text)
      return async () => { throw new Error('fixture network error') }
    }, { charThreshold: 1, onError: () => { throw new Error('fixture reporter error') } })
    item.append('text')
    await Promise.resolve()
    await item.complete()
    expect(staged).toEqual(['text'])
  })

  it('dispose prevents a scheduled microtask from staging a stale answer', async () => {
    const staged: string[] = []
    const item = buffer(text => { staged.push(text); return async () => {} }, { charThreshold: 1 })
    item.append('cancelled')
    item.dispose()
    item.append('late event')
    await Promise.resolve()
    await item.complete()
    expect(staged).toEqual([])
  })
})
