import { describe, expect, test } from 'bun:test'
import { FocusedRequests } from './focusedRequests'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('screen request focus and ordering', () => {
  test('a server creation can finish after leaving, without navigating on blur or later refocus', async () => {
    const requests = new FocusedRequests()
    const creation = deferred<string>()
    const navigation: string[] = []
    requests.focus()
    const request = requests.begin()!
    const completed = creation.promise.then((id) => {
      if (request.isCurrent()) navigation.push(id)
      return id
    })
    requests.blur()
    requests.focus()
    creation.resolve('created-on-computer-A')
    expect(await completed).toBe('created-on-computer-A')
    expect(navigation).toEqual([])
    expect(request.signal.aborted).toBe(true)
    const current = requests.begin()!
    if (current.isCurrent()) navigation.push('created-on-current-screen')
    expect(navigation).toEqual(['created-on-current-screen'])
  })

  test('a slow older preview cannot overwrite the newest file even if its adapter ignores abort', async () => {
    const requests = new FocusedRequests()
    requests.focus()
    let preview = ''
    const a = deferred<string>()
    const b = deferred<string>()
    const first = requests.begin()!
    const firstResult = a.promise.then((value) => {
      if (first.isCurrent()) preview = value
    })
    const last = requests.begin()!
    const lastResult = b.promise.then((value) => {
      if (last.isCurrent()) preview = value
    })
    expect(first.signal.aborted).toBe(true)
    b.resolve('file B')
    await lastResult
    a.resolve('file A')
    await firstResult
    expect(preview).toBe('file B')
    expect(last.signal.aborted).toBe(false)
  })

  test('returning to the list invalidates a late file response while permitting another selection', async () => {
    const requests = new FocusedRequests()
    requests.focus()
    let preview: string | null = 'previous file'
    const response = deferred<string>()
    const request = requests.begin()!
    const completed = response.promise.then((value) => {
      if (request.isCurrent()) preview = value
    })
    requests.invalidate()
    preview = null
    response.resolve('late file')
    await completed
    expect(preview).toBeNull()
    expect(request.signal.aborted).toBe(true)
    expect(requests.begin()?.isCurrent()).toBe(true)
  })

  test('late failures and finally callbacks cannot clear a newer loading state', async () => {
    const requests = new FocusedRequests()
    requests.focus()
    let error = ''
    let loading = true
    const response = deferred<string>()
    const request = requests.begin()!
    const completed = response.promise
      .catch((e) => {
        if (request.isCurrent()) error = e.message
      })
      .finally(() => {
        if (request.isCurrent()) loading = false
      })
    requests.begin()
    response.reject(new Error('old failure'))
    await completed
    expect(error).toBe('')
    expect(loading).toBe(true)
  })

  test('blur or disposal rejects new work and invalidates the active request', () => {
    const requests = new FocusedRequests()
    expect(requests.begin()).toBeNull()
    requests.focus()
    const request = requests.begin()!
    requests.blur()
    requests.blur()
    expect(request.isCurrent()).toBe(false)
    expect(request.signal.aborted).toBe(true)
    expect(requests.begin()).toBeNull()
  })
})
