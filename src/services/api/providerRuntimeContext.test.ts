import { expect, test } from 'bun:test'
import { bindProviderRuntimeGenerator, getProviderRuntimeContext, getProviderRuntimeEnvironment, runWithProviderRuntime, type ProviderRuntimeContext } from './providerRuntimeContext.js'

const runtime = (providerId: string): ProviderRuntimeContext => ({ providerId, runtimeKind: 'anthropic_compatible', env: { ANTHROPIC_MODEL: providerId } })

test('isolates overlapping asynchronous providers and inherits the current runtime in nested work', async () => {
  const results = await Promise.all(['a', 'b'].map(providerId => runWithProviderRuntime(runtime(providerId), async () => {
    await Promise.resolve()
    const nested = await Promise.resolve().then(() => getProviderRuntimeContext()?.providerId)
    return [getProviderRuntimeEnvironment().ANTHROPIC_MODEL, nested]
  })))
  expect(results).toEqual([['a', 'a'], ['b', 'b']])
  expect(getProviderRuntimeContext()).toBeUndefined()
  expect(getProviderRuntimeEnvironment()).toBe(process.env)
})

test('binds lazy generator steps and cancellation cleanup to the child provider', async () => {
  const seen: string[] = []
  async function* work() {
    try {
      seen.push(getProviderRuntimeContext()!.providerId)
      await Promise.resolve()
      yield getProviderRuntimeEnvironment().ANTHROPIC_MODEL
    } finally {
      seen.push(`cleanup:${getProviderRuntimeContext()!.providerId}`)
    }
  }
  const iterator = bindProviderRuntimeGenerator(runtime('child'), work())
  expect(await iterator.next()).toEqual({ done: false, value: 'child' })
  await runWithProviderRuntime(runtime('other'), () => iterator.return())
  expect(seen).toEqual(['child', 'cleanup:child'])
  expect(getProviderRuntimeContext()).toBeUndefined()
})
