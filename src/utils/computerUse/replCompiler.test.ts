import { describe, expect, test } from 'bun:test'
import { compileReplCell } from './replCompiler'

describe('computer use REPL compiler', () => {
  test.each([
    'first()\nsecond()',
    'first() // a comment must not consume the boundary\nsecond()',
    'let value = first()\nsecond(value)',
    'var value = first()\nsecond(value)',
    'function run() { return first()\nsecond() }\nsecond(run())',
    'try { throw first()\nsecond() } catch (value) { second(value) }',
    'if (true) first()\nelse second()\nsecond()',
    'for (let i = 0; i < 2; i++) first()\nsecond()',
    'for (var value of [1, 2]) first()\nsecond(value)',
    'for (var value in {a: 1}) { first()\nsecond(value) }',
    'first()\nsecond`text`',
  ])('preserves JavaScript statement boundaries when rewriting free calls: %s', async code => {
    async function execute(compiled: boolean) {
      const calls: unknown[][] = []
      const values: Record<string, unknown> = {
        first: () => { calls.push(['first']); return 7 },
        second: (...args: unknown[]) => { calls.push(['second', ...args]); return 9 },
      }
      if (compiled) {
        const cell = compileReplCell(code, [])
        const run = new Function(`return ${cell.source}`)()
        await run(() => ({ values }), (bindings: Array<[string, string, () => unknown, (value: unknown) => void]>) => {
          for (const [name, , get, set] of bindings) Object.defineProperty(values, name, { get, set, configurable: true })
        }, () => {})
      } else {
        await new Function('first', 'second', `return (async () => { ${code}\n})()`)(values.first, values.second)
      }
      return calls
    }
    expect(await execute(true)).toEqual(await execute(false))
  })

  test('collects persistent declarations without capturing nested lexical scopes', () => {
    const compiled = compileReplCell(`
      const { x, nested: { y = 2 }, ...rest } = source
      let [first, ...tail] = values
      async function act() { const local = 1; return local }
      class Target {}
      for (var index of [1, 2]) { var visited = index; let scoped = 3 }
      { let hidden = 4; function nested() {} }
    `, [])
    expect(compiled.bindings).toEqual([
      { name: 'x', kind: 'const' },
      { name: 'y', kind: 'const' },
      { name: 'rest', kind: 'const' },
      { name: 'first', kind: 'let' },
      { name: 'tail', kind: 'let' },
      { name: 'act', kind: 'function' },
      { name: 'Target', kind: 'class' },
      { name: 'index', kind: 'var' },
      { name: 'visited', kind: 'var' },
    ])
  })

  test('accepts top level await and redeclarations of prior bindings', () => {
    const compiled = compileReplCell('const app = await select(); let next = app', [
      { name: 'app', kind: 'const' },
      { name: 'previous', kind: 'let' },
    ])
    expect(compiled.bindings).toEqual([
      { name: 'previous', kind: 'let' },
      { name: 'app', kind: 'const' },
      { name: 'next', kind: 'let' },
    ])
  })

  test.each([
    'import fs from "node:fs"',
    'await import("node:fs")',
    'async function later() { return import("node:fs") }',
    'export const x = 1',
    'import.meta.url',
  ])('rejects module access: %s', code => {
    expect(() => compileReplCell(code, [])).toThrow('not available')
  })

  test('rejects syntax errors before any execution', () => {
    expect(() => compileReplCell('await action(); const broken =', [])).toThrow()
  })

  test('warns for writes to previous const bindings without confusing local shadows or object properties', () => {
    const prior = [{ name: 'count', kind: 'const' as const }]
    expect(compileReplCell('count++', prior).warnings).toHaveLength(1)
    expect(compileReplCell('({value: count} = source)', prior).warnings).toHaveLength(1)
    expect(compileReplCell('function increment() { count++ }', prior).warnings).toHaveLength(1)
    for (const code of [
      'count.value++',
      'function local(count) { count++ }',
      'function local() { count++; var count = 0 }',
      '{ let count = 0; count++ }',
      'for (let count = 0; count < 2; count++) {}',
      'try {} catch (count) { count++ }',
    ]) {
      expect(compileReplCell(code, prior).warnings).toEqual([])
    }
  })
})
