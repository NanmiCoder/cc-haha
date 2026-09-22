import { describe, expect, it } from 'vitest'
import { boundActivityText } from './chatHistoryBudget'

describe('chat activity retention', () => {
  it('retains recent terminal records and every active lifecycle, including active-to-terminal transitions', () => {
    const records = Object.fromEntries(Array.from({ length: 700 }, (_, index) => [String(index), {
      taskId: String(index), status: 'completed', updatedAt: index,
    }]))
    records.active = { taskId: 'active', status: 'running', updatedAt: 0 }
    const bounded = boundActivityText(records, 1024 * 1024)!
    expect(Object.keys(bounded)).toHaveLength(501)
    expect(bounded['199']).toBeUndefined()
    expect(bounded['200']).toBe(records['200'])
    expect(bounded.active).toBe(records.active)
    const completed = boundActivityText({ ...bounded, active: { ...bounded.active!, status: 'completed', updatedAt: 999 } }, 1024 * 1024)!
    expect(Object.keys(completed)).toHaveLength(500)
    expect(completed.active).toMatchObject({ taskId: 'active', status: 'completed', updatedAt: 999 })
    expect(completed['200']).toBeUndefined()
    const allRunning = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [String(index), { taskId: String(index), status: 'running' }]))
    expect(boundActivityText(allRunning, 1024, 2)).toBe(allRunning)
  })

  it('memoizes unchanged activity records by identity and budgets instead of scanning on each delta', () => {
    let enumerations = 0
    const records = new Proxy({ task: { status: 'completed', result: 'result' } }, {
      ownKeys(target) { enumerations++; return Reflect.ownKeys(target) },
    })
    const first = boundActivityText(records, 1024, 500)
    for (let index = 0; index < 100; index++) expect(boundActivityText(records, 1024, 500)).toBe(first)
    expect(enumerations).toBe(1)
    boundActivityText(records, 512, 500)
    expect(enumerations).toBe(2)
    boundActivityText(records, 512, 100)
    expect(enumerations).toBe(3)
  })

})
