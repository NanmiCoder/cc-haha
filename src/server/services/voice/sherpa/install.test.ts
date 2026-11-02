import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceDownloadError } from '../download/index.js'
import { makeTarball } from './__fixtures__/fakeAssets.js'
import { extractWithSystemTar, removeInstall } from './install.js'
import { modelLayout, type ModelLayout } from './layout.js'

let dir: string
let layout: ModelLayout

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'voice-install-'))
  layout = modelLayout(dir, 'sensevoice')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('extractWithSystemTar', () => {
  it('unpacks an npm tarball without its package/ prefix, using paths relative to cwd', async () => {
    await mkdir(join(dir, 'downloads'), { recursive: true })
    await mkdir(join(dir, 'staging', 'pkg'), { recursive: true })
    await writeFile(join(dir, 'downloads', 'pkg.tgz'), await makeTarball({ 'sherpa-onnx.js': 'entry', 'lib/deep.txt': 'deep' }))

    await extractWithSystemTar({
      cwd: dir,
      archive: 'downloads/pkg.tgz',
      into: 'staging/pkg',
      signal: new AbortController().signal,
    })

    expect(await readFile(join(dir, 'staging', 'pkg', 'sherpa-onnx.js'), 'utf8')).toBe('entry')
    expect(await readFile(join(dir, 'staging', 'pkg', 'lib', 'deep.txt'), 'utf8')).toBe('deep')
    expect(await stat(join(dir, 'staging', 'pkg', 'package')).catch(() => undefined)).toBeUndefined()
  })

  it('reports a corrupt archive as a storage failure', async () => {
    await mkdir(join(dir, 'staging'), { recursive: true })
    await writeFile(join(dir, 'broken.tgz'), 'not a tarball')

    const error = await extractWithSystemTar({
      cwd: dir, archive: 'broken.tgz', into: 'staging', signal: new AbortController().signal,
    }).catch(e => e)

    expect(error).toBeInstanceOf(VoiceDownloadError)
    expect(error.failure.reason).toBe('storage')
  })

  it('stops when cancelled before it starts', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(extractWithSystemTar({ cwd: dir, archive: 'x.tgz', into: '.', signal: controller.signal }))
      .rejects.toThrow('cancelled')
  })
})

describe('removeInstall', () => {
  it('removes everything under the provider directory and tolerates a missing one', async () => {
    await mkdir(layout.models, { recursive: true })
    await writeFile(join(layout.models, 'a'), 'a')
    await removeInstall(layout)
    expect(await stat(layout.base).catch(() => undefined)).toBeUndefined()
    await removeInstall(layout)
  })
})
