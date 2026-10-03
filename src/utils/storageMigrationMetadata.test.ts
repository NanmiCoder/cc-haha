import { afterEach, describe, expect, test } from 'bun:test'
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { relocateManagedData } from './storageMigrationMetadata.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'storage-metadata-'))
  roots.push(root)
  const source = join(root, 'source')
  const target = join(root, 'target')
  const stage = join(root, 'stage')
  await mkdir(source)
  const put = async (relativePath: string, value: unknown) => {
    const file = join(source, relativePath)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return { root, source, target, stage, put }
}

describe('copied storage metadata migration', () => {
  test('preserves both runtime and canonical roots and relocates canonical connector paths from an alias', async () => {
    const { root, source, target, stage, put } = await fixture()
    const alias = join(root, 'runtime-alias')
    await symlink(source, alias, 'junction')
    const directory = join(source, 'connectors', 'runtime', 'dingtalk', '1.0.50-win32-x64')
    await put('connectors/state.json', { connectors: { dingtalk: { enabled: true, installation: {
      directory, command: join(directory, 'dws.exe'), args: [], env: {},
    } } } })
    await cp(source, stage, { recursive: true })
    await relocateManagedData(alias, target, stage)
    const state = JSON.parse(await readFile(join(stage, 'connectors/state.json'), 'utf8'))
    expect(state.connectors.dingtalk).toMatchObject({ enabled: true, installation: { directory: join(target, 'connectors/runtime/dingtalk/1.0.50-win32-x64') } })
    expect(JSON.parse(await readFile(join(stage, 'cc-haha/storage-relocations.json'), 'utf8')).previousRoots).toEqual([alias, source])
  })

  test('rebases old connector/plugin fixtures, regenerates owned skills and preserves shared state and transcript bytes', async () => {
    const { root, source, target, stage, put } = await fixture()
    const older = join(root, 'older')
    const nativeDir = join(source, 'connectors', 'runtime', 'dingtalk', '1.0.50-win32-x64')
    const cache = join(source, 'plugins', 'cache', 'haha-connectors', 'office-dingtalk', '1.0.50-connector.1')
    await put('cc-haha/storage-relocations.json', { version: 1, previousRoots: [older, source], futureField: { keep: true } })
    await put('connectors/state.json', { unknown: 123, connectors: { dingtalk: { installed: true, enabled: true, installedVersion: '1.0.50', unknownRecord: 'keep', installation: {
      directory: nativeDir, command: join(nativeDir, 'dws.exe'), args: [], env: { DWS_CONFIG_DIR: join(source, 'connectors', 'accounts', 'dingtalk', 'dws'), DWS_KEYCHAIN_DIR: join(source, 'connectors', 'accounts', 'dingtalk', 'keychain'), DWS_DISABLE_KEYCHAIN: '1', UNKNOWN: 'keep' }, unknownInstall: true,
    } } } })
    await put('plugins/known_marketplaces.json', {
      'haha-connectors': { source: { source: 'directory', path: join(source, 'connectors', 'marketplace'), unknown: true }, installLocation: join(source, 'connectors', 'marketplace'), extra: true },
      external: { source: { source: 'file', path: join(root, 'external.json') }, installLocation: join(root, 'external.json') },
    })
    await put('plugins/installed_plugins.json', { version: 2, extra: true, plugins: { 'office-dingtalk@haha-connectors': [{ installPath: cache, projectPath: '/external/project', scope: 'user', version: '1.0.50-connector.1', unknown: 'keep' }] } })
    await put('plugins/cache/haha-connectors/office-dingtalk/1.0.50-connector.1/skills/office-dingtalk/SKILL.md', 'old generated skill')
    await put('connectors/marketplace/plugins/office-dingtalk/skills/office-dingtalk/SKILL.md', 'old generated skill')
    const settings = JSON.stringify({ enabledPlugins: { 'office-dingtalk@haha-connectors': true }, unknown: true })
    const transcript = JSON.stringify({ type: 'user', message: { content: `@"${join(source, 'uploads', 'session', 'image.png')}" historical text` } }) + '\n'
    await put('settings.json', settings)
    await put('projects/repo/session.jsonl', transcript)
    await cp(source, stage, { recursive: true })
    await relocateManagedData(source, target, stage)
    const state = JSON.parse(await readFile(join(stage, 'connectors', 'state.json'), 'utf8'))
    expect(state).toMatchObject({ unknown: 123, connectors: { dingtalk: { enabled: true, unknownRecord: 'keep', installation: { directory: nativeDir.replace(source, target), unknownInstall: true, env: { UNKNOWN: 'keep', DWS_CONFIG_DIR: join(target, 'connectors', 'accounts', 'dingtalk', 'dws') } } } } })
    const marketplaces = JSON.parse(await readFile(join(stage, 'plugins', 'known_marketplaces.json'), 'utf8'))
    expect(marketplaces['haha-connectors']).toMatchObject({ extra: true, source: { path: join(target, 'connectors', 'marketplace'), unknown: true } })
    expect(marketplaces.external.installLocation).toBe(join(root, 'external.json'))
    const plugins = JSON.parse(await readFile(join(stage, 'plugins', 'installed_plugins.json'), 'utf8'))
    expect(plugins.plugins['office-dingtalk@haha-connectors'][0]).toMatchObject({ installPath: cache.replace(source, target), projectPath: '/external/project', unknown: 'keep' })
    for (const file of ['plugins/cache/haha-connectors/office-dingtalk/1.0.50-connector.1/skills/office-dingtalk/SKILL.md', 'connectors/marketplace/plugins/office-dingtalk/skills/office-dingtalk/SKILL.md']) {
      const skill = await readFile(join(stage, file), 'utf8')
      expect(skill).toContain(nativeDir.replace(source, target))
      expect(skill).toContain('@1.0.50')
      expect(skill).not.toContain(source)
    }
    expect(await readFile(join(stage, 'settings.json'), 'utf8')).toBe(settings)
    expect(await readFile(join(stage, 'projects/repo/session.jsonl'), 'utf8')).toBe(transcript)
    expect(await readFile(join(source, 'connectors/marketplace/plugins/office-dingtalk/skills/office-dingtalk/SKILL.md'), 'utf8')).toBe('old generated skill')
    expect(JSON.parse(await readFile(join(stage, 'cc-haha/storage-relocations.json'), 'utf8')))
      .toEqual({ version: 1, previousRoots: [older, source], futureField: { keep: true } })
  })

  test('supports old plugin V1/cowork fixtures even when the old source no longer exists', async () => {
    const { source, target, stage, put } = await fixture()
    await put('cowork_plugins/installed_plugins.json', { version: 1, plugins: { 'plugin@market': { installPath: join(source, 'cowork_plugins/cache/plugin'), version: '1' } } })
    await cp(source, stage, { recursive: true })
    await rm(source, { recursive: true })
    await relocateManagedData(source, target, stage)
    expect(JSON.parse(await readFile(join(stage, 'cowork_plugins/installed_plugins.json'), 'utf8')).plugins['plugin@market'].installPath)
      .toBe(join(target, 'cowork_plugins/cache/plugin'))
  })

  test('rejects unsupported schemas and overlapping previous roots', async () => {
    const { source, target, stage, put } = await fixture()
    await put('cc-haha/storage-relocations.json', { version: 2, previousRoots: [] })
    await cp(source, stage, { recursive: true })
    await expect(relocateManagedData(source, target, stage)).rejects.toThrow('Unsupported')
    await writeFile(join(stage, 'cc-haha/storage-relocations.json'), JSON.stringify({ version: 1, previousRoots: [join(target, 'nested')] }))
    await expect(relocateManagedData(source, target, stage)).rejects.toThrow('overlaps')
  })

  test('rejects linked metadata instead of modifying a protected outside file', async () => {
    const { root, source, target, stage } = await fixture()
    await mkdir(join(stage, 'connectors'), { recursive: true })
    const outside = join(root, 'outside.json')
    const content = '{"connectors":{}}'
    await writeFile(outside, content)
    await link(outside, join(stage, 'connectors/state.json'))
    await expect(relocateManagedData(source, target, stage)).rejects.toThrow('independent')
    expect(await readFile(outside, 'utf8')).toBe(content)
  })
})
