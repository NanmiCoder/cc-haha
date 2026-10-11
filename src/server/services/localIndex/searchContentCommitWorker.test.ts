import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  commitSearchContentSpool,
  getSearchCommitWorkerForTests,
  withSearchProjectionBudget,
} from './searchContentCommitWorker.js'
import { openSearchContentDatabase } from './searchContentDatabase.js'
import type { SearchContentSourceWrite } from './searchContentIndex.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function commitFixture() {
  const root = await mkdtemp(join(tmpdir(), 'search-commit-worker-'))
  directories.push(root)
  const databasePath = join(root, 'search.sqlite')
  const database = openSearchContentDatabase({ path: databasePath })
  const spool = (name: string, rows = 1) => {
    const path = join(root, `${name}.spool.sqlite`)
    const db = new Database(path)
    db.exec('CREATE TABLE documents (seq INTEGER PRIMARY KEY, jsonlLine INTEGER, byteStart INTEGER, byteLength INTEGER, segmentIndex INTEGER, role TEXT, messageId TEXT, timestamp TEXT, body TEXT, normalizedBody TEXT)')
    const insert = db.query('INSERT INTO documents (jsonlLine, byteStart, byteLength, segmentIndex, role, messageId, timestamp, body, normalizedBody) VALUES (?, ?, ?, 0, ?, NULL, NULL, ?, ?)')
    db.transaction(() => {
      for (let i = 0; i < rows; i++) insert.run(i + 1, i * 100, 100, 'user', `${name} body ${i}`, `${name} body ${i}`)
    })()
    db.close()
    return path
  }
  const source = (name: string, rows = 1): SearchContentSourceWrite => ({
    path: join(root, 'projects', '-repo', `${name}.jsonl`),
    projectPath: '-repo',
    ownerSessionId: name,
    ownerTranscriptPath: join(root, 'projects', '-repo', `${name}.jsonl`),
    modifiedAtMs: 1,
    sizeBytes: rows * 100,
    mtimeMs: 1,
    fileIdentity: null,
    fingerprint: name,
    indexedBytes: rows * 100,
    indexedLines: rows,
    parserVersion: 1,
    state: 'ready',
    lastErrorCode: null,
    updatedAtMs: 1,
  })
  const commit = (name: string, options: { rows?: number; signal?: AbortSignal; onStarted?: () => void } = {}) =>
    commitSearchContentSpool({ databasePath, spoolPath: spool(name, options.rows), source: source(name, options.rows), append: false, signal: options.signal, onStarted: options.onStarted })
  const owners = () => database.read(reader => reader.all<{ ownerSessionId: string }>('SELECT DISTINCT owner_session_id AS ownerSessionId FROM search_sources ORDER BY owner_session_id')).map(row => row.ownerSessionId)
  // A fresh connection that refuses to wait: it can write only if no commit
  // still holds the index's write lock.
  const writeLockFree = () => {
    const probe = new Database(databasePath)
    try {
      probe.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK')
      return true
    } catch {
      return false
    } finally { probe.close() }
  }
  return { root, database, commit, owners, writeLockFree }
}

test('serves consecutive commits from one long-lived worker', async () => {
  // Bun keeps ~185KB of native memory per finished Worker; one worker per
  // commit grew the desktop server by tens of MB a minute.
  const { database, commit, owners } = await commitFixture()
  try {
    const workers = new Set<unknown>()
    for (let i = 0; i < 5; i++) {
      await commit(`session-${i}`)
      workers.add(getSearchCommitWorkerForTests())
    }
    expect(workers.size).toBe(1)
    expect([...workers][0]).not.toBeNull()
    expect(owners()).toEqual(['session-0', 'session-1', 'session-2', 'session-3', 'session-4'])
  } finally { database.close() }
})

test('a commit cancelled while queued never runs and later commits still land', async () => {
  const { database, commit, owners } = await commitFixture()
  try {
    const controller = new AbortController()
    const first = commit('first')
    const cancelled = commit('cancelled', { signal: controller.signal }).catch(error => error)
    controller.abort()
    expect((await cancelled).name).toBe('AbortError')
    await first
    await commit('after')
    expect(owners()).toEqual(['after', 'first'])
  } finally { database.close() }
})

test('aborting a commit mid-write rejects the caller and a fresh worker serves the next commit', async () => {
  // terminate() cannot interrupt a synchronous SQLite write already in flight,
  // so the aborted commit may or may not land; the projector retries either way.
  const { database, commit, owners } = await commitFixture()
  try {
    await commit('before')
    const previousWorker = getSearchCommitWorkerForTests()
    const controller = new AbortController()
    const aborted = commit('aborted', {
      rows: 200_000,
      signal: controller.signal,
      onStarted: () => { setTimeout(() => controller.abort(), 20) },
    }).catch(error => error)
    expect((await aborted).name).toBe('AbortError')
    await commit('after')
    expect(getSearchCommitWorkerForTests()).not.toBe(previousWorker)
    expect(owners()).toEqual(expect.arrayContaining(['after', 'before']))
  } finally { database.close() }
}, 30_000)

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

test('commits stay correct while the main thread opens and closes other databases', async () => {
  // bun:sqlite handle open/close races across threads: rows landed in the
  // wrong database and commits failed with "Cannot use a closed database".
  const { root, database, commit, owners } = await commitFixture()
  try {
    const otherPath = join(root, 'other.sqlite')
    const setup = new Database(otherPath)
    setup.exec('CREATE TABLE t (who TEXT)')
    setup.close()
    let done = false
    let churned = 0
    // One open/close per macrotask, so the churn overlaps the worker's commits
    // instead of alternating with them.
    const churn = new Promise<void>(resolve => {
      const tick = () => {
        if (done) return resolve()
        const other = new Database(otherPath)
        other.query('INSERT INTO t VALUES (?)').run('main')
        other.close()
        churned += 1
        setImmediate(tick)
      }
      tick()
    })
    // Probabilistic: the Bun race needs both threads inside open/close at once.
    // Against the per-job-open worker this failed in roughly 2 of 5 runs.
    const names = Array.from({ length: 150 }, (_, i) => `churn-${String(i).padStart(3, '0')}`)
    const results = await Promise.allSettled(names.map(name => commit(name)))
    done = true
    await churn
    expect(results.filter(result => result.status === 'rejected').map(result => String((result as PromiseRejectedResult).reason))).toEqual([])
    expect(owners()).toEqual(names)
    const other = new Database(otherPath, { readonly: true })
    try {
      expect(other.query('SELECT who, COUNT(*) AS n FROM t GROUP BY who').all()).toEqual([{ who: 'main', n: churned }])
    } finally { other.close() }
  } finally { database.close() }
}, 60_000)

test('a cancelled commit has released the write lock by the time its caller settles', async () => {
  const { root, database, commit } = await commitFixture()
  // Opened up front: probing must not give the worker time to finish rolling back.
  const probe = new Database(join(root, 'search.sqlite'))
  probe.exec('PRAGMA busy_timeout=0')
  try {
    await commit('warm')
    for (let attempt = 0; attempt < 10; attempt++) {
      const controller = new AbortController()
      const cancelled = commit(`race-${attempt}`, { signal: controller.signal }).catch(error => error)
      // Give the worker time to claim the job before the cancel arrives.
      const until = performance.now() + 30
      while (performance.now() < until) { /* busy main thread */ }
      controller.abort()
      expect((await cancelled).name).toBe('AbortError')
      let locked = false
      try { probe.exec('BEGIN IMMEDIATE; ROLLBACK') } catch { locked = true }
      expect({ attempt, locked }).toEqual({ attempt, locked: false })
    }
  } finally {
    probe.close()
    database.close()
  }
})

test('a thrown onStarted rolls back without replacing the worker', async () => {
  const { database, commit, owners, writeLockFree } = await commitFixture()
  try {
    await commit('before')
    const worker = getSearchCommitWorkerForTests()
    // Not expect(...).rejects: in Bun 1.3.14 that wait does not deliver the
    // worker's messages, so the commit (waiting on its gate) never settles.
    const error = await commit('thrown', { onStarted: () => { throw new Error('observer failed') } }).catch(reason => reason)
    expect((error as Error).message).toBe('observer failed')
    expect(writeLockFree()).toBe(true)
    expect(getSearchCommitWorkerForTests()).toBe(worker)
    await commit('after')
    expect(owners()).toEqual(['after', 'before'])
  } finally { database.close() }
})

test('cancelling a commit after the worker already claimed the next one settles both', async () => {
  // terminate() cannot interrupt Atomics.wait: a claimed job left waiting on
  // its gate kept the worker alive and the index write-locked forever.
  const { database, commit, writeLockFree } = await commitFixture()
  try {
    const controller = new AbortController()
    const first = commit('first', {
      signal: controller.signal,
      onStarted: () => {
        // Runs right after the gate opens: hold the main thread while the
        // worker finishes `first` and claims `second`, then cancel `first`.
        queueMicrotask(() => {
          const until = performance.now() + 300
          while (performance.now() < until) { /* busy main thread */ }
          controller.abort()
        })
      },
    }).then(() => 'committed', error => error)
    const second = commit('second').then(() => 'committed', error => error)
    const settled = await Promise.race([
      Promise.all([first, second]),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000)),
    ])
    expect(settled).not.toBe('timeout')
    expect(writeLockFree()).toBe(true)
    await commit('after')
  } finally { database.close() }
}, 30_000)

test('cancelling a running commit also settles the commits queued behind it', async () => {
  const { database, commit, owners, writeLockFree } = await commitFixture()
  try {
    const controller = new AbortController()
    const running = commit('running', {
      rows: 200_000,
      signal: controller.signal,
      onStarted: () => { setTimeout(() => controller.abort(), 20) },
    }).catch(error => error)
    const queued = commit('queued').then(() => 'committed', error => error)
    const settled = await Promise.race([
      Promise.all([running, queued]),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 20_000)),
    ])
    expect(settled).not.toBe('timeout')
    expect(writeLockFree()).toBe(true)
    await commit('after')
    expect(owners()).toEqual(expect.arrayContaining(['after']))
  } finally { database.close() }
}, 30_000)
