import { describe, it, expect } from 'bun:test'
import { enqueue } from '../chat-queue.js'

describe('ChatQueue', () => {
  it('executes tasks for the same chatId serially', async () => {
    const order: number[] = []

    await Promise.all([
      enqueue('chat-1', async () => {
        await new Promise((r) => setTimeout(r, 30))
        order.push(1)
      }),
      enqueue('chat-1', async () => {
        order.push(2)
      }),
      enqueue('chat-1', async () => {
        order.push(3)
      }),
    ])

    // Wait for all to complete
    await new Promise((r) => setTimeout(r, 50))
    expect(order).toEqual([1, 2, 3])
  })

  it('executes tasks for different chatIds in parallel', async () => {
    const order: string[] = []

    const p1 = enqueue('chat-a', async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push('a')
    })

    const p2 = enqueue('chat-b', async () => {
      order.push('b') // should run immediately, not wait for chat-a
    })

    await Promise.all([p1, p2])
    await new Promise((r) => setTimeout(r, 50))

    // 'b' should appear before 'a' since chat-a has a delay
    expect(order[0]).toBe('b')
    expect(order[1]).toBe('a')
  })

  it('continues processing after a task fails', async () => {
    const order: number[] = []

    await enqueue('chat-err', async () => {
      order.push(1)
      throw new Error('task failed')
    })

    await enqueue('chat-err', async () => {
      order.push(2) // should still run
    })

    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual([1, 2])
  })
})
