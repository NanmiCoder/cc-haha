import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withSearchProjectionBudget } from './searchContentCommitWorker.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

test('bounds active projections and pending work and removes cancelled waiters', async () => {
  let release!: () => void
  const active = withSearchProjectionBudget(undefined, () => new Promise<void>(resolve => { release = resolve }))
  const controller = new AbortController()
  const cancelled = withSearchProjectionBudget(controller.signal, async () => 'unexpected').catch(error => error)
  const queued = Array.from({ length: 7 }, () => withSearchProjectionBudget(undefined, async () => 'ok'))
  await expect(withSearchProjectionBudget(undefined, async () => 'overflow')).rejects.toThrow('SEARCH_CONTENT_BUSY')
  controller.abort()
  expect((await cancelled).name).toBe('AbortError')
  const replacement = withSearchProjectionBudget(undefined, async () => 'replacement')
  release()
  await active
  expect(await Promise.all(queued)).toEqual(Array(7).fill('ok'))
  expect(await replacement).toBe('replacement')
})

test('inline SQLite commit worker survives bun --compile without external worker source assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'search-worker-compiled-'))
  directories.push(directory)
  const script = join(directory, 'entry.ts')
  const binary = join(directory, 'compiled-search')
  const databaseModule = new URL('./searchContentDatabase.ts', import.meta.url).pathname
  const indexModule = new URL('./searchContentIndex.ts', import.meta.url).pathname
  const projectorModule = new URL('./searchContentProjector.ts', import.meta.url).pathname
  await writeFile(script, `
    import { writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { openSearchContentDatabase } from ${JSON.stringify(databaseModule)}
    import { createSearchContentIndex } from ${JSON.stringify(indexModule)}
    import { createSearchContentProjector } from ${JSON.stringify(projectorModule)}
    const root = process.argv[2]
    const source = join(root, 'session.jsonl')
    await writeFile(source, JSON.stringify({type:'user',message:{role:'user',content:'compiled worker searchable text'}})+'\\n')
    const database = openSearchContentDatabase({path:join(root,'search.sqlite')})
    const index = createSearchContentIndex(database,{scope:root})
    const result = await createSearchContentProjector({database,index}).projectSource({path:source,projectPath:root,ownerSessionId:'compiled',ownerTranscriptPath:source,modifiedAtMs:1})
    const row = database.read(reader=>reader.get('SELECT body FROM search_documents'))
    database.close()
    if(result.kind!=='indexed'||row.body!=='compiled worker searchable text') throw new Error(JSON.stringify({result,row}))
    console.log('compiled worker passed')
  `)
  const build = Bun.spawn([process.execPath, 'build', '--compile', '--minify', script, '--outfile', binary], { stdout: 'pipe', stderr: 'pipe' })
  const [buildCode, buildError] = await Promise.all([build.exited, new Response(build.stderr).text()])
  expect({ code: buildCode, error: buildCode ? buildError : '' }).toEqual({ code: 0, error: '' })
  if (process.platform === 'darwin') {
    // Match the sidecar packaging smoke: Bun's compiled Mach-O needs a fresh ad-hoc signature.
    for (const args of [['--remove-signature', binary], ['--sign', '-', '--force', binary]]) {
      const sign = Bun.spawn(['codesign', ...args], { stdout: 'pipe', stderr: 'pipe' })
      const [code, error] = await Promise.all([sign.exited, new Response(sign.stderr).text()])
      expect({ code, error: code ? error : '' }).toEqual({ code: 0, error: '' })
    }
  }
  await rm(script)
  const run = Bun.spawn([binary, directory], { stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  expect(stdout).toContain('compiled worker passed')
}, 30_000)
