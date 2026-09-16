import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillBundleAdapter, readSkillBundleFiles } from './skillAdapter.js'
import type { ConnectorDefinition, SkillBundleRecipe } from './types.js'

const bytes = Buffer.from('---\nname: fixture\ndescription: Fixture skill\n---\nRead references before use.\n')
const recipe: SkillBundleRecipe = { id: 'fixture', version: '1.0.0', repository: 'example/skills', commit: 'a'.repeat(40), license: 'MIT', files: [{ source: 'skills/fixture/SKILL.md', target: 'skills/fixture/SKILL.md', integrity: `sha256-${createHash('sha256').update(bytes).digest('hex')}` }] }
const definition: ConnectorDefinition = { id: 'fixture', version: '1.0.0', pluginId: 'office-fixture@haha-connectors', packageName: 'fixture', homepage: 'https://example.com', credentialMode: 'isolated', transport: 'skills', collection: 'tools', platforms: ['darwin-arm64'] }
const roots: string[] = []
async function root() { const path = await mkdtemp(join(tmpdir(), 'skill bundle 中文 ')); roots.push(path); return path }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

test('downloads pinned allowlisted files and verifies locally without login or executing software', async () => {
  const path = await root()
  const urls: string[] = []
  const adapter = createSkillBundleAdapter(definition, path, recipe, async sources => { urls.push(...sources); return bytes })
  const installation = await adapter.prepare(new AbortController().signal, () => {})
  expect(urls).toEqual([`https://raw.githubusercontent.com/example/skills/${'a'.repeat(40)}/skills/fixture/SKILL.md`])
  expect(await adapter.check(installation, new AbortController().signal)).toEqual({ authenticated: true, verification: 'local' })
  await adapter.prepare(new AbortController().signal, () => {})
  expect(urls).toHaveLength(1)
  await adapter.deactivate()
  expect(await readSkillBundleFiles(recipe, installation.directory)).toHaveLength(1)
  const protectedPath = join(path, 'credentials.json')
  await writeFile(protectedPath, 'keep')
  await adapter.remove(installation)
  expect(await readFile(protectedPath, 'utf8')).toBe('keep')
  await expect(adapter.remove({ ...installation, directory: path })).rejects.toThrow('Invalid')
})

test('checksum errors and cancellation cannot publish an incomplete bundle', async () => {
  const path = await root()
  const adapter = createSkillBundleAdapter(definition, path, recipe, async () => Buffer.from('bad'))
  await expect(adapter.prepare(new AbortController().signal, () => {})).rejects.toThrow('checksum')
  await expect(readFile(join(path, 'bundles/fixture/1.0.0/skills/fixture/SKILL.md'))).rejects.toThrow()
  const controller = new AbortController()
  const aborting = createSkillBundleAdapter(definition, path, recipe, async () => { controller.abort(); return bytes })
  await expect(aborting.prepare(controller.signal, () => {})).rejects.toThrow()
  await expect(readFile(join(path, 'bundles/fixture/1.0.0/skills/fixture/SKILL.md'))).rejects.toThrow()
})

test('rejects traversal, duplicate targets, unpinned sources and symlinked installed members', async () => {
  const path = await root()
  for (const invalid of [{ ...recipe, commit: 'main' }, { ...recipe, files: [...recipe.files, ...recipe.files] }, { ...recipe, files: [{ ...recipe.files[0]!, target: 'skills/../outside' }] }]) {
    expect(() => createSkillBundleAdapter(definition, path, invalid)).toThrow('Invalid')
  }
  const adapter = createSkillBundleAdapter(definition, path, recipe, async () => bytes)
  const installation = await adapter.prepare(new AbortController().signal, () => {})
  const file = join(installation.directory, 'skills/fixture/SKILL.md')
  const external = join(path, 'external.md')
  await writeFile(external, bytes)
  await rm(file)
  await symlink(external, file)
  await expect(adapter.check(installation, new AbortController().signal)).rejects.toThrow('Invalid skill bundle member')
})
