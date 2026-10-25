import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'bun:test'

test('failed same-provider catalog retries independently and aborted responses cannot overwrite a new provider', () => {
  // Run the real hook with deterministic state/effect scheduling; isolate native
  // substitutes so they cannot contaminate the rest of the mobile test process.
  const dir = mkdtempSync(join(tmpdir(), 'mobile-runtime-hook-'))
  const script = `
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
const root = ${JSON.stringify(fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, ''))}
let cursor = 0
const slots: any[] = []
let effects: (() => void)[] = []
let dirty = false
const equal = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
mock.module(\`\${root}/mobile/node_modules/react\`, () => ({
  default: {},
  useState(initial: any) {
    const id = cursor++
    if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial
    return [slots[id], (next: any) => { const value = typeof next === 'function' ? next(slots[id]) : next; if (!Object.is(value, slots[id])) { slots[id] = value; dirty = true } }]
  },
  useMemo(make: () => any, deps: unknown[]) {
    const id = cursor++
    if (!slots[id] || !equal(slots[id].deps, deps)) slots[id] = { deps, value: make() }
    return slots[id].value
  },
  useEffect(effect: () => any, deps: unknown[]) {
    const id = cursor++
    if (!slots[id] || !equal(slots[id].deps, deps)) {
      const previous = slots[id]
      slots[id] = { deps }
      effects.push(() => { previous?.cleanup?.(); slots[id].cleanup = effect() })
    }
  },
}))
mock.module(\`\${root}/mobile/node_modules/react-native\`, () => ({ FlatList: 'FlatList', View: 'View', useWindowDimensions: () => ({height:844}) }))
mock.module(\`\${root}/mobile/src/ui/Text\`, () => ({ Text: 'Text' }))
mock.module(\`\${root}/mobile/src/ui/kit\`, () => ({ Button:'Button',Callout:'Callout',InlineError:'InlineError',Loading:'Loading',Sheet:'Sheet',SearchField:'SearchField',TextButton:'TextButton',useColors:()=>({}) }))
mock.module(\`\${root}/mobile/src/ui/theme\`, () => ({ errorText:String }))
mock.module(\`\${root}/mobile/src/ui/newtask/ChoiceRow\`, () => ({ ChoiceRow:'ChoiceRow' }))
let modelCalls = 0, directoryCalls = 0
let slowResolve, slowSignal
const directory = { activeId: null, sources:[{id:null,auth:'ready',name:'Claude'},{id:'slow',auth:'ready',name:'Slow'},{id:'next',auth:'ready',name:'Next'}] }
mock.module(\`\${root}/mobile/src/core/runtimeCatalog\`, () => ({
  canSetRuntimeEffort:()=>true, runtimeProviderIdentity:(id:any)=>id, modelDetail:()=>'', runtimeModelSelection:(providerId,model)=>({providerId,modelId:model.id}),
  loadRuntimeDirectory:async()=>{ directoryCalls++; return directory },
  loadRuntimeModels:async(_client,_directory,id,signal)=>{
    modelCalls++
    if (modelCalls===1) throw new Error('catalog unavailable')
    if (id==='slow') { slowSignal=signal; return new Promise(resolve=>{slowResolve=resolve}) }
    return [{id:id==='next'?'next-model':'recovered',name:'Recovered'}]
  },
}))
const { useRuntimeChoice } = await import(\`\${root}/mobile/src/ui/RuntimePicker\`)
const client = {}
let choice: ReturnType<typeof useRuntimeChoice>
async function settle() {
  for (let i=0;i<8;i++) {
    cursor = 0; dirty = false
    choice = useRuntimeChoice({client:client as any})
    const pending = effects; effects=[]; pending.forEach((effect)=>effect())
    await Promise.resolve(); await Promise.resolve()
    if (!dirty && !effects.length) return
  }
}
await settle()
assert.equal(modelCalls,1)
assert.equal(choice!.catalogReady,false)
assert.ok(choice!.error)
choice!.selectProvider(null)
await settle()
assert.equal(modelCalls,2,'same failed provider must retry the model catalog')
assert.equal(choice!.error,'')
assert.equal(choice!.catalogReady,true)
assert.equal(choice!.models[0].id,'recovered')
assert.equal(directoryCalls,1,'retry must not reload directory or reset chosen provider')
choice!.selectProvider('slow')
await settle()
assert.equal(choice!.catalogReady,false)
choice!.selectProvider('next')
await settle()
assert.equal(slowSignal.aborted,true,'changing provider aborts its pending catalog')
assert.equal(choice!.models[0].id,'next-model')
slowResolve([{id:'stale',name:'Stale'}])
await settle()
assert.equal(choice!.providerId,'next')
assert.equal(choice!.models[0].id,'next-model','late aborted response must not replace destination catalog')
assert.equal(directoryCalls,1)

  `
  try {
    const file = join(dir, 'hook.ts')
    writeFileSync(file, script)
    execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
