import { expect, test } from 'bun:test'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'

test('execFileNoThrowWithCwd cancels a child with the current execa API', async () => {
  const controller = new AbortController()
  const startedAt = Date.now()
  const child = execFileNoThrowWithCwd(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 30_000)'],
    { abortSignal: controller.signal, timeout: 30_000 },
  )
  controller.abort()

  const result = await child
  expect(result.code).not.toBe(0)
  expect(Date.now() - startedAt).toBeLessThan(5_000)
})
