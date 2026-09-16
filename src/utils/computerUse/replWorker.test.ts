import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComputerUseReplWorker } from './replWorker'
import { REPL_BOOTSTRAP_SOURCE } from '../../vendor/computer-use-mcp/replApi'

type Message = Record<string, any>

function fixture() {
  const messages: Message[] = []
  const worker = createComputerUseReplWorker(message => messages.push(message))
  return { worker, messages }
}

async function init(worker: ReturnType<typeof createComputerUseReplWorker>) {
  await worker.receive({ type: 'init', bootstrap: `
    const nodeRepl = Object.freeze({
      write(value) { __cuEmit({type:'text', text: JSON.stringify(value)}) }
    })
  ` })
}

function texts(messages: Message[]) {
  return messages.filter(message => message.type === 'emit').map(message => message.content.text)
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('worker event did not arrive')
}

describe('computer use persistent REPL worker', () => {
  test('closures and later cells read and write one persistent lexical binding', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: 'let count=0; function step(){count+=1}; function current(){return count}' })
    await worker.receive({ type: 'run', cellId: 2, code: 'step(); nodeRepl.write({count,current:current()})' })
    await worker.receive({ type: 'run', cellId: 3, code: 'count=10; step(); nodeRepl.write({count,current:current()})' })
    expect(texts(messages)).toEqual(['{"count":1,"current":1}', '{"count":11,"current":11}'])
    expect(messages.filter(message => message.type === 'done').every(message => !message.error)).toBe(true)
  })

  test('helpers resolve a future top-level App without replacing the VM global object', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      function target(){return app}
      function futureMath(){return Math}
      function missing(){return typeof absent}
      const originalMath = globalThis.Math
      nodeRepl.write(missing())
    ` })
    await worker.receive({ type: 'run', cellId: 2, code: `
      let app = {name:'Fixture'}
      let Math = {name:'local'}
      let absent = 3
      nodeRepl.write([target().name, futureMath().name, missing(), globalThis.Math===originalMath])
    ` })
    expect(texts(messages)).toEqual(['"undefined"', '["Fixture","local","number",true]'])
    expect(messages.filter(message => message.type === 'done').every(message => !message.error)).toBe(true)
  })

  test('shared references preserve shorthand, destructuring, shadowing and lexical call receivers', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      let count=1
      function read(){return count}
      function receiver(){return this}
      function tagged(){return this}
      function defaults(value=count){var count=7; return [value,count,arguments.length]}
      class View { #value=3; current(){return count+this.#value} self(){return View} }
    ` })
    await worker.receive({ type: 'run', cellId: 2, code: `
      ({count}= {count:4})
      let output={count}
      let [a,b=count] = [1]
      { let count=8; output.block=count }
      for(let count=0;count<2;count++){output.loop=count}
      function local(count){return (()=>count)()}
      function hoisted(){count=5;var count;return count}
      const named=function count(){return count.name}
      try {throw 6} catch(count){output.caught=count}
      let view = new View()
      nodeRepl.write([output,a,b,read(),local(9),hoisted(),named(),view.current(),view.self()===View,
        receiver()===undefined,tagged\`x\`===undefined,defaults()])
    ` })
    expect(texts(messages)).toEqual(['[{"count":4,"block":8,"loop":1,"caught":6},1,4,4,9,5,"count",7,true,true,true,[4,7,0]]'])
    expect(messages.filter(message => message.type === 'done').every(message => !message.error)).toBe(true)
  })

  test('failed declarations retain partial initialization and restore slots visible to old closures', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: 'let app="old"; function selected(){return app}; const fixed=1; function constant(){return fixed}' })
    await worker.receive({ type: 'run', cellId: 2, code: 'let app=selected()' })
    expect(messages.find(message => message.type === 'done' && message.cellId===2).error).toMatch(/initializ|before/i)
    await worker.receive({ type: 'run', cellId: 3, code: 'nodeRepl.write(selected()); const [first,second=(()=>{throw Error("stop")})()] = [7]' })
    await worker.receive({ type: 'run', cellId: 4, code: 'fixed=2; nodeRepl.write([first,typeof second,constant()]); const same=1; same=2' })
    expect(texts(messages)).toEqual(['"old"', 'Warning: fixed was declared with const; use let for reassignable variables.', '[7,"undefined",2]'])
    expect(messages.find(message => message.type === 'done' && message.cellId===4).error).toContain('constant')
  })

  test('an existing App helper follows rebinding and never dispatches to the old App', async () => {
    const { worker, messages } = fixture()
    await worker.receive({ type: 'init', bootstrap: REPL_BOOTSTRAP_SOURCE })
    const run = async (cellId: number, code: string) => {
      const running = worker.receive({ type: 'run', cellId, code })
      const replied = new Set<number>()
      while (!messages.some(message => message.type === 'done' && message.cellId === cellId)) {
        for (const request of messages.filter(message => message.type === 'invoke' && message.cellId === cellId && !replied.has(message.requestId))) {
          replied.add(request.requestId)
          await worker.receive({ type: 'response', cellId, requestId: request.requestId,
            result: { app: request.args.app, content: [{ type: 'text', text: 'fixture state' }] } })
        }
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      await running
    }
    await run(1, 'let app = await cua.getApp("First"); async function build(){await app.click([1,2])}')
    await run(2, 'app = await cua.getApp("Second"); await build()')
    await run(3, 'let app = await cua.getApp("Third"); await build()')
    expect(messages.filter(message => message.type === 'invoke' && message.name === 'click').map(message => message.args.app)).toEqual(['Second', 'Third'])
    expect(messages.filter(message => message.type === 'done').every(message => !message.error)).toBe(true)
  })

  test('retains top level await, variables, functions and object identity across cells', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      const app = await Promise.resolve({clicks: 0})
      let count = 2
      function label() { return app.clicks }
      class View { constructor() { this.app = app } }
    ` })
    await worker.receive({ type: 'run', cellId: 2, code: `
      app.clicks++; count += 3
      nodeRepl.write([count, label(), new View().app === app])
    ` })
    await worker.receive({ type: 'run', cellId: 3, code: 'const app = {clicks: 9}; nodeRepl.write(app.clicks)' })
    expect(texts(messages)).toEqual(['[5,1,true]', 'Warning: app was declared with const; use let for reassignable variables.', '9'])
    expect(messages.filter(message => message.type === 'done').every(message => !message.error)).toBe(true)
  })

  test('tolerates prior const reassignment with a warning and saves initialized bindings after failure', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: 'let count = 1; const fixed = 5' })
    await worker.receive({ type: 'run', cellId: 2, code: 'count = 3; const reached = 7; throw new Error("stop"); const unreached = 8' })
    await worker.receive({ type: 'run', cellId: 3, code: 'nodeRepl.write([count, reached, typeof unreached]); fixed = 4' })
    expect(texts(messages)).toEqual(['Warning: fixed was declared with const; use let for reassignable variables.', '[3,7,"undefined"]'])
    expect(messages.find(message => message.type === 'done' && message.cellId === 2).error).toContain('stop')
    expect(messages.find(message => message.type === 'done' && message.cellId === 3).error).toBeUndefined()
    await worker.receive({ type: 'run', cellId: 4, code: 'nodeRepl.write(fixed); const local = 1; local = 2' })
    expect(texts(messages).at(-1)).toBe('4')
    expect(messages.find(message => message.type === 'done' && message.cellId === 4).error).toMatch(/constant|readonly/i)
  })

  test('failed cells retain reached declarations but discard unreached var and function bindings', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      var before = 1
      var declared
      function beforeFn() { return 2 }
      throw new Error('stop')
      var after = 3
      function afterFn() { return 4 }
    ` })
    await worker.receive({ type: 'run', cellId: 2, code: `
      nodeRepl.write([before, beforeFn(), declared, typeof afterFn,
        (() => { try { after; return 'BOUND' } catch { return 'ABSENT' } })()])
    ` })
    expect(texts(messages)).toEqual(['[1,2,null,"undefined","ABSENT"]'])
  })

  test('failed loop declarations commit only when their initialization or iteration executes', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      for (var index = 0; index < 2; index++) {}
      for (var { value, nested: [item] } of [{ value: 3, nested: [4] }]) {}
      for (var key in {a: 1}) {}
      for (var single of [6]) if (single === 6) continue
      for (var empty of []) {}
      for (var emptyKey in {}) {}
      throw new Error('stop')
      for (var unseen = 0; unseen < 2; unseen++) {}
    ` })
    await worker.receive({ type: 'run', cellId: 2, code: `
      nodeRepl.write([index, value, item, key, single,
        (() => { try { empty; return 'BOUND' } catch { return 'ABSENT' } })(),
        (() => { try { emptyKey; return 'BOUND' } catch { return 'ABSENT' } })(),
        (() => { try { unseen; return 'BOUND' } catch { return 'ABSENT' } })()])
    ` })
    expect(texts(messages)).toEqual(['[2,3,4,"a",6,"ABSENT","ABSENT","ABSENT"]'])
  })

  test('failed replacements retain old values while successful cells preserve ordinary hoisting', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: 'let app = {value: 7}; var previous = 8; function existing() { return 9 }' })
    await worker.receive({ type: 'run', cellId: 2, code: `
      let app = await Promise.reject(new Error('replacement failed'))
      var previous = 99
      function existing() { return 99 }
    ` })
    await worker.receive({ type: 'run', cellId: 3, code: `
      nodeRepl.write([app.value, previous, existing()])
      if (false) { var skipped = 1 }
      for (var empty of []) {}
      function local() { var neverGlobal = 1; return neverGlobal }
    ` })
    await worker.receive({ type: 'run', cellId: 4, code: 'nodeRepl.write([skipped, empty, typeof local, typeof neverGlobal])' })
    expect(texts(messages)).toEqual(['[7,8,9]', '[null,null,"function","undefined"]'])
  })

  test('preserves executed writes before a future var declaration without committing short-circuited writes', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      future = 9
      orValue ||= 3
      nullishValue ??= 4
      andValue &&= 5
      throw new Error('stop')
      var future, orValue, nullishValue, andValue
    ` })
    await worker.receive({ type: 'run', cellId: 2, code: `
      nodeRepl.write([future, orValue, nullishValue,
        (() => { try { andValue; return 'BOUND' } catch { return 'ABSENT' } })()])
    ` })
    expect(texts(messages)).toEqual(['[9,3,4,"ABSENT"]'])
  })

  test('serializes bridge results and errors into the VM realm', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    const running = worker.receive({ type: 'run', cellId: 1, code: `
      const result = await __cuInvoke('get_app_state', {app:'Fixture'})
      nodeRepl.write([result.value, Object.getPrototypeOf(result) === Object.prototype])
      try { await __cuInvoke('click', {x:1,y:2}) }
      catch (error) { nodeRepl.write([error instanceof Error, error.message]) }
    ` })
    await until(() => messages.some(message => message.type === 'invoke'))
    const first = messages.find(message => message.type === 'invoke')
    expect(first).toMatchObject({ cellId: 1, name: 'get_app_state', args: { app: 'Fixture' } })
    await worker.receive({ type: 'response', cellId: 99, requestId: first.requestId, result: { value: 99 } })
    await worker.receive({ type: 'response', cellId: 1, requestId: first.requestId, result: { value: 4 } })
    await until(() => messages.filter(message => message.type === 'invoke').length === 2)
    const second = messages.filter(message => message.type === 'invoke')[1]!
    await worker.receive({ type: 'response', cellId: 1, requestId: second.requestId, error: 'fixture failure' })
    await running
    expect(texts(messages)).toEqual(['[4,true]', '[true,"fixture failure"]'])
  })

  test('awaits already dispatched work but prevents detached calls after submitted code completes', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    const running = worker.receive({ type: 'run', cellId: 1, code: `
      void __cuInvoke('click', {x:1}).then(() => __cuInvoke('click', {x:2})).catch(error => nodeRepl.write(error.message))
    ` })
    await until(() => messages.some(message => message.type === 'invoke'))
    expect(messages.some(message => message.type === 'done')).toBe(false)
    const first = messages.find(message => message.type === 'invoke')
    await worker.receive({ type: 'response', cellId: 1, requestId: first.requestId, result: {} })
    await running
    expect(messages.filter(message => message.type === 'invoke')).toHaveLength(1)
    expect(messages.filter(message => message.type === 'done')).toHaveLength(1)
    await worker.receive({ type: 'run', cellId: 2, code: 'nodeRepl.write("next")' })
    expect(messages.filter(message => message.type === 'invoke')).toHaveLength(1)
  })

  test('reports failure of an unawaited dispatched operation instead of claiming success', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    const running = worker.receive({ type: 'run', cellId: 1, code: 'void __cuInvoke("click", {})' })
    await until(() => messages.some(message => message.type === 'invoke'))
    await Promise.resolve()
    const request = messages.find(message => message.type === 'invoke')
    await worker.receive({ type: 'response', cellId: 1, requestId: request.requestId, error: 'target moved' })
    await running
    expect(messages.find(message => message.type === 'done').error).toContain('target moved')
  })

  test('retains an unobserved failure received while a different awaited call is pending', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    const running = worker.receive({ type: 'run', cellId: 1, code: `
      void __cuInvoke('click', {})
      await __cuInvoke('get_app_state', {})
    ` })
    await until(() => messages.filter(message => message.type === 'invoke').length === 2)
    const [first, second] = messages.filter(message => message.type === 'invoke')
    await worker.receive({ type: 'response', cellId: 1, requestId: first!.requestId, error: 'first action failed' })
    await worker.receive({ type: 'response', cellId: 1, requestId: second!.requestId, result: {} })
    await running
    expect(messages.find(message => message.type === 'done').error).toContain('first action failed')
  })

  test('an ignored structured native rejection cannot become a successful cell', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    const running = worker.receive({ type: 'run', cellId: 1, code: 'void __cuInvoke("click", {})' })
    await until(() => messages.some(message => message.type === 'invoke'))
    const request = messages.find(message => message.type === 'invoke')!
    await worker.receive({ type: 'response', cellId: 1, requestId: request.requestId, result: {
      isError: true, content: [{ type: 'text', text: 'native command rejected' }],
      nativeError: { name: 'SkyComputerUseError', message: 'native command rejected', code: -10007 },
    } })
    await running
    expect(messages.find(message => message.type === 'done').error).toContain('native command rejected')
  })

  test('allows explicit error handling of a returned operation', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    const running = worker.receive({ type: 'run', cellId: 1, code: `
      const recovery = __cuInvoke('click', {}).catch(() => 'handled')
      nodeRepl.write(await recovery)
    ` })
    await until(() => messages.some(message => message.type === 'invoke'))
    const request = messages.find(message => message.type === 'invoke')
    await worker.receive({ type: 'response', cellId: 1, requestId: request.requestId, error: 'expected' })
    await running
    expect(messages.find(message => message.type === 'done').error).toBeUndefined()
    expect(texts(messages)).toEqual(['"handled"'])
  })

  test('waits for the host rejection checkpoint before reporting cell completion', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    const running = worker.receive({ type: 'run', cellId: 1, code: 'await Promise.resolve()' })
    // Flushing only promise continuations must not publish done. The host
    // needs a complete turn to report ignored async App-method rejections.
    for (let index = 0; index < 20; index++) {
      await Promise.resolve()
    }
    expect(messages.some(message => message.type === 'done')).toBe(false)
    await running
    expect(messages.some(message => message.type === 'done')).toBe(true)
  })

  test('observes after an awaited timer between paste and observation', async () => {
    const messages: Message[] = []
    const worker = createComputerUseReplWorker(message => {
      messages.push(message)
      if (message.type === 'invoke') queueMicrotask(() => worker.receive({
        type: 'response', cellId: message.cellId, requestId: message.requestId,
        result: { app: 'Fixture', content: [{ type: 'text', text: 'fixture state' }] },
      }))
    })
    await worker.receive({ type: 'init', bootstrap: REPL_BOOTSTRAP_SOURCE })
    await worker.receive({ type: 'run', cellId: 1, code: `
      let app = await cua.getApp('Fixture')
      await app.paste('query')
      await new Promise(resolve => setTimeout(resolve, 0))
      await app.getAXState()
    ` })
    expect(messages.find(message => message.type === 'done').error).toBeUndefined()
    expect(messages.filter(message => message.type === 'invoke').map(message => message.name))
      .toEqual(['get_app_state', 'paste', 'get_app_state'])
  })

  test('supports timer callback arguments, asynchronous zero delay, and either clear function', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      let order = ['sync']
      let original = {name: 'same object'}
      let canceled = setTimeout(() => order.push('canceled'), 0)
      clearInterval(canceled)
      clearTimeout(undefined)
      let ticks = 0
      await new Promise(resolve => {
        const id = setInterval((text, object) => {
          order.push([text, object === original, typeof id])
          if (++ticks === 2) { clearTimeout(id); resolve() }
        }, 0, 'tick', original)
      })
      await new Promise(resolve => setTimeout((value) => {order.push(value); resolve()}, undefined, 'last'))
      nodeRepl.write(order)
    ` })
    expect(texts(messages)).toEqual(['["sync",["tick",true,"number"],["tick",true,"number"],"last"]'])
    expect(messages.find(message => message.type === 'done').error).toBeUndefined()
  })

  test('allows an awaited timer callback to dispatch in its active cell', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    const running = worker.receive({ type: 'run', cellId: 1, code: `
      await new Promise(resolve => {
        const id = setInterval(async () => {
          clearInterval(id)
          await __cuInvoke('click', {x: 12, y: 34})
          resolve()
        }, 0)
      })
      nodeRepl.write('finished')
    ` })
    await until(() => messages.some(message => message.type === 'invoke'))
    const request = messages.find(message => message.type === 'invoke')!
    expect(request).toMatchObject({ cellId: 1, name: 'click', args: { x: 12, y: 34 } })
    await worker.receive({ type: 'response', cellId: 1, requestId: request.requestId, result: {} })
    await running
    expect(messages.filter(message => message.type === 'invoke')).toHaveLength(1)
    expect(messages.find(message => message.type === 'done').error).toBeUndefined()
    expect(texts(messages)).toEqual(['"finished"'])
  })

  test('clears detached timers on successful and failed cells before another cell can run', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      let late = 0
      setTimeout(() => { late++; __cuInvoke('click', {}) }, 0)
      setInterval(() => { late++; __cuInvoke('paste', {}) }, 0)
    ` })
    await worker.receive({ type: 'run', cellId: 2, code: `
      setTimeout(() => { late++; __cuInvoke('click', {}) }, 0)
      setInterval(() => { late++; __cuInvoke('paste', {}) }, 0)
      throw Error('expected cell failure')
    ` })
    await worker.receive({ type: 'run', cellId: 3, code: `
      await new Promise(resolve => setTimeout(resolve, 30))
      nodeRepl.write(late)
    ` })
    expect(messages.find(message => message.type === 'done' && message.cellId === 2).error).toContain('expected cell failure')
    expect(messages.find(message => message.type === 'done' && message.cellId === 3).error).toBeUndefined()
    expect(messages.filter(message => message.type === 'invoke')).toEqual([])
    expect(texts(messages)).toEqual(['0'])
  })

  test('rejects timer scheduling or clearing from a previous cell continuation', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      let release, currentTimer, staleErrors = []
      const gate = new Promise(resolve => { release = resolve })
      gate.then(() => {
        try { clearTimeout(currentTimer) } catch (error) { staleErrors.push(error.message) }
        try { setTimeout(() => __cuInvoke('click', {}), 0) } catch (error) { staleErrors.push(error.message) }
      })
    ` })
    await worker.receive({ type: 'run', cellId: 2, code: `
      await new Promise(resolve => {
        currentTimer = setTimeout(resolve, 5)
        release()
      })
      nodeRepl.write(staleErrors)
    ` })
    expect(messages.find(message => message.type === 'done' && message.cellId === 2).error).toBeUndefined()
    expect(JSON.parse(texts(messages)[0]!)).toEqual([
      expect.stringContaining('cell has ended'), expect.stringContaining('cell has ended'),
    ])
    expect(messages.filter(message => message.type === 'invoke')).toEqual([])
  })

  test.each(['throw Error("timer broke")', 'await Promise.resolve(); throw Error("timer broke")'])(
    'fails the awaiting cell on timer callback error: %s', async body => {
      const { worker, messages } = fixture()
      await init(worker)
      await worker.receive({ type: 'run', cellId: 1, code: `
        setTimeout(${body.includes('await') ? 'async ' : ''}() => { ${body} }, 0)
        setTimeout(() => __cuInvoke('click', {}), 10)
        await new Promise(() => {})
      ` })
      await worker.receive({ type: 'run', cellId: 2, code: `
        await new Promise(resolve => setTimeout(resolve, 20))
        nodeRepl.write('recovered')
      ` })
      expect(messages.find(message => message.type === 'done' && message.cellId === 1).error).toContain('timer broke')
      expect(messages.find(message => message.type === 'done' && message.cellId === 2).error).toBeUndefined()
      expect(messages.filter(message => message.type === 'invoke')).toEqual([])
      expect(texts(messages)).toEqual(['"recovered"'])
    },
  )

  test('does not dispatch a suspended timer callback after its cell has ended', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      let release
      await new Promise(started => {
        setTimeout(async () => {
          started()
          await new Promise(resolve => { release = resolve })
          await __cuInvoke('click', {})
        }, 0)
      })
    ` })
    await worker.receive({ type: 'run', cellId: 2, code: `
      release()
      await new Promise(resolve => setTimeout(resolve, 10))
      nodeRepl.write('current cell')
    ` })
    expect(messages.filter(message => message.type === 'invoke')).toEqual([])
    expect(messages.filter(message => message.type === 'done').every(message => !message.error)).toBe(true)
    expect(texts(messages)).toEqual(['"current cell"'])
  })

  test('rejects string callbacks and bounds active timers while retaining a usable cell', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      try { setTimeout('globalThis.escaped=true', 0) } catch (error) { nodeRepl.write(error.message) }
      try { setInterval(null, 0) } catch (error) { nodeRepl.write(error.message) }
      let timers = []
      for (let i=0; i<1024; i++) timers.push(setTimeout(() => {}, 60000))
      try { setTimeout(() => {}, 0) } catch (error) { nodeRepl.write(error.message) }
      timers.forEach(clearTimeout)
      await new Promise(resolve => setTimeout(resolve, 0))
      nodeRepl.write(typeof escaped)
    ` })
    expect(texts(messages)).toEqual([
      '"Timer callback must be a function"', '"Timer callback must be a function"',
      '"Too many active JavaScript timers (maximum 1024)"', '"undefined"',
    ])
    expect(messages.find(message => message.type === 'done').error).toBeUndefined()
  })

  test('exposes realm timers without Node host objects, a module loader or code generation', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      nodeRepl.write([typeof process, typeof require, typeof Buffer, typeof setTimeout, typeof arguments])
      for (const candidate of [() => Function('return 1')(), () => __cuInvoke.constructor('return process')(),
        () => console.log.constructor('return process')(), ...[setTimeout, clearTimeout, setInterval, clearInterval]
          .map(timer => () => timer.constructor('return process')())]) {
        try { candidate(); nodeRepl.write('escaped') } catch { nodeRepl.write('blocked') }
      }
      await new Promise(resolve => setTimeout(function () {
        nodeRepl.write(this === globalThis)
        const handle = setTimeout(resolve, 0)
        nodeRepl.write([typeof handle, typeof handle.ref, setTimeout instanceof Function])
      }, 0))
    ` })
    expect(texts(messages)).toEqual([
      '["undefined","undefined","undefined","function","undefined"]',
      ...Array(7).fill('"blocked"'), 'false', '["number","undefined",true]',
    ])
    await worker.receive({ type: 'run', cellId: 2, code: 'await import("node:fs")' })
    expect(messages.find(message => message.type === 'done' && message.cellId === 2).error).toContain('not available')
  })

  test('rejects concurrent cells instead of sharing active context', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    const running = worker.receive({ type: 'run', cellId: 1, code: 'await __cuInvoke("click", {})' })
    await until(() => messages.some(message => message.type === 'invoke'))
    await worker.receive({ type: 'run', cellId: 2, code: 'nodeRepl.write("overlap")' })
    expect(messages.find(message => message.type === 'done' && message.cellId === 2).error).toContain('already running')
    const request = messages.find(message => message.type === 'invoke')
    await worker.receive({ type: 'response', cellId: 1, requestId: request.requestId, result: {} })
    await running
    expect(texts(messages)).toEqual([])
  })

  test('does not retain a phantom request after a transport failure', async () => {
    const messages: Message[] = []
    const worker = createComputerUseReplWorker(message => {
      if (message.type === 'invoke') throw new Error('transport unavailable')
      messages.push(message)
    })
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: 'await __cuInvoke("click", {})' })
    expect(messages.find(message => message.type === 'done').error).toContain('transport unavailable')
    await worker.receive({ type: 'run', cellId: 2, code: 'nodeRepl.write("recovered")' })
    expect(texts(messages)).toEqual(['"recovered"'])
  })

  test('cannot move a previous cell continuation into a later cell', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    await worker.receive({ type: 'run', cellId: 1, code: `
      let release
      const gate = new Promise(resolve => { release = resolve })
      gate.then(() => __cuInvoke('click', {stale: true})).catch(() => {})
    ` })
    await worker.receive({ type: 'run', cellId: 2, code: 'release(); await Promise.resolve(); nodeRepl.write("current")' })
    expect(messages.filter(message => message.type === 'invoke')).toEqual([])
    expect(texts(messages)).toEqual(['"current"'])
  })

  test('provides the actual CUA bootstrap in the same persistent realm', async () => {
    const { worker, messages } = fixture()
    await worker.receive({ type: 'init', bootstrap: REPL_BOOTSTRAP_SOURCE })
    await worker.receive({ type: 'run', cellId: 1, code: 'let value = await Promise.resolve(4); nodeRepl.write(value)' })
    await worker.receive({ type: 'run', cellId: 2, code: 'nodeRepl.write([typeof cua.getApp, value])' })
    expect(texts(messages)).toHaveLength(2)
    expect(texts(messages).join(' ')).toContain('function')
    expect(messages.filter(message => message.type === 'done').every(message => !message.error)).toBe(true)
  })

  test('responds to host health checks even while a cell awaits a UI response', async () => {
    const { worker, messages } = fixture()
    await init(worker)
    const running = worker.receive({ type: 'run', cellId: 1, code: 'await __cuInvoke("click", {})' })
    await until(() => messages.some(message => message.type === 'invoke'))
    await worker.receive({ type: 'ping', nonce: 42 })
    expect(messages.at(-1)).toEqual({ type: 'pong', nonce: 42 })
    const request = messages.find(message => message.type === 'invoke')
    await worker.receive({ type: 'response', cellId: 1, requestId: request.requestId, result: {} })
    await running
  })

  test('runs the same persistent protocol in a separate process with a disposable home', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cu-repl-worker-'))
    const child = Bun.spawn([process.execPath, '--no-env-file', new URL('./replWorker.ts', import.meta.url).pathname], {
      cwd: directory,
      env: { HOME: directory, TMPDIR: directory, CLAUDE_CONFIG_DIR: directory },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const messages: Message[] = []
    const write = (message: Message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
      child.stdin.flush()
    }
    const reading = (async () => {
      let buffered = ''
      const decoder = new TextDecoder()
      for await (const bytes of child.stdout) {
        buffered += decoder.decode(bytes, { stream: true })
        let newline: number
        while ((newline = buffered.indexOf('\n')) !== -1) {
          const message = JSON.parse(buffered.slice(0, newline))
          buffered = buffered.slice(newline + 1)
          messages.push(message)
          if (message.type === 'invoke') {
            write({ type: 'response', cellId: message.cellId, requestId: message.requestId, result: { value: message.args.value } })
          }
        }
      }
    })()
    try {
      write({ type: 'init', bootstrap: '' })
      await until(() => messages.some(message => message.type === 'ready'))
      write({ type: 'ping', nonce: 7 })
      await until(() => messages.some(message => message.type === 'pong' && message.nonce === 7))
      write({ type: 'run', cellId: 1, code: 'let total = 2' })
      await until(() => messages.some(message => message.type === 'done' && message.cellId === 1))
      write({ type: 'run', cellId: 2, code: `
        for (const value of [3, 4]) { total += (await __cuInvoke('fixture', {value})).value }
        await new Promise(resolve => setTimeout(resolve, 0))
        __cuEmit({type:'text', text:String(total)})
      ` })
      await until(() => messages.some(message => message.type === 'done' && message.cellId === 2))
      expect(messages.filter(message => message.type === 'invoke').map(message => message.args)).toEqual([{ value: 3 }, { value: 4 }])
      expect(texts(messages)).toEqual(['9'])
      expect(messages.filter(message => message.type === 'done').every(message => !message.error)).toBe(true)
      child.stdin.end()
      await reading
      expect(await child.exited).toBe(0)
    } finally {
      child.kill()
      await child.exited
      await rm(directory, { recursive: true, force: true })
    }
  })
})
