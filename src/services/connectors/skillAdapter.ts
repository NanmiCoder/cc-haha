import { mkdir, readFile, rename, rm, writeFile, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { downloadVerified, verifyIntegrity } from './managedRuntime.js'
import type { ConnectorAdapter, ConnectorDefinition, ConnectorInstallation, SkillBundleRecipe } from './types.js'

function validateRecipe(recipe: SkillBundleRecipe) {
  if (!/^[a-z][a-z0-9-]*$/.test(recipe.id) || !/^\d+\.\d+\.\d+$/.test(recipe.version) || !/^[\w.-]+\/[\w.-]+$/.test(recipe.repository) || !/^[a-f0-9]{40}$/.test(recipe.commit)) throw new Error('Invalid skill bundle identity')
  if (!recipe.files.length || recipe.files.length > 600) throw new Error('Invalid skill bundle size')
  const targets = new Set<string>()
  for (const file of recipe.files) {
    const safePath = (path: string) => /^[A-Za-z0-9_./ -]+$/.test(path) && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.' || !part)
    if (!safePath(file.source) || !safePath(file.target) || !/^(skills\/|LICENSE)/.test(file.target) || !/^sha256-[a-f0-9]{64}$/.test(file.integrity) || targets.has(file.target)) throw new Error('Invalid skill bundle file')
    targets.add(file.target)
  }
  if (!recipe.files.some(file => /^skills\/[^/]+\/SKILL.md$/.test(file.target))) throw new Error('Skill bundle has no entry point')
}

// Read only lockfile-listed regular files. Never follow package symlinks or copy
// an arbitrary extracted tree into the plugin loader.
export async function readSkillBundleFiles(recipe: SkillBundleRecipe, directory: string): Promise<Array<{ target: string, bytes: Uint8Array }>> {
  validateRecipe(recipe)
  const root = resolve(directory)
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('Invalid skill bundle directory')
  const output: Array<{ target: string, bytes: Uint8Array }> = []
  let total = 0
  for (const file of recipe.files) {
    const parts = file.target.split('/')
    for (let count = 1; count <= parts.length; count++) {
      const stat = await lstat(join(root, ...parts.slice(0, count)))
      if (stat.isSymbolicLink() || (count === parts.length ? !stat.isFile() : !stat.isDirectory())) throw new Error('Invalid skill bundle member')
      if (stat.size > 8 * 1024 * 1024) throw new Error('Skill bundle member exceeds size limit')
    }
    const bytes = await readFile(join(root, file.target))
    total += bytes.length
    if (total > 32 * 1024 * 1024) throw new Error('Skill bundle exceeds size limit')
    verifyIntegrity(bytes, file.integrity)
    output.push({ target: file.target, bytes })
  }
  return output
}

export function createSkillBundleAdapter(definition: ConnectorDefinition, root: string, recipe: SkillBundleRecipe, download = downloadVerified): ConnectorAdapter {
  validateRecipe(recipe)
  if (definition.id !== recipe.id || definition.version !== recipe.version || definition.pluginId !== `office-${recipe.id}@haha-connectors`) throw new Error('Invalid managed skill identity')
  const directory = join(resolve(root), 'bundles', recipe.id, recipe.version)
  const installation: ConnectorInstallation = { directory, command: '', args: [], env: {} }
  const validate = (value: ConnectorInstallation) => {
    if (resolve(value.directory) !== directory || value.command || value.args.length || Object.keys(value.env).length) throw new Error('Invalid managed skill installation')
  }
  return {
    async prepare(signal, progress) {
      signal.throwIfAborted()
      try { await readSkillBundleFiles(recipe, directory); signal.throwIfAborted(); return installation } catch { signal.throwIfAborted() }
      const stage = `${directory}.stage-${randomUUID()}`
      const backup = `${directory}.backup-${randomUUID()}`
      let replaced = false
      await mkdir(stage, { recursive: true, mode: 0o700 })
      try {
        progress('downloading')
        let total = 0
        for (const file of recipe.files) {
          signal.throwIfAborted()
          const url = `https://raw.githubusercontent.com/${recipe.repository}/${recipe.commit}/${file.source.split('/').map(encodeURIComponent).join('/')}`
          const bytes = await download([url], file.integrity, signal)
          verifyIntegrity(bytes, file.integrity)
          total += bytes.length
          if (bytes.length > 8 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('Skill bundle exceeds size limit')
          const path = join(stage, file.target)
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          await writeFile(path, bytes, { mode: 0o600 })
        }
        progress('verifying')
        await readSkillBundleFiles(recipe, stage)
        signal.throwIfAborted()
        try { await rename(directory, backup); replaced = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        try { await rename(stage, directory) } catch (error) { if (replaced) await rename(backup, directory); throw error }
        if (replaced) await rm(backup, { recursive: true, force: true })
        return installation
      } finally { await rm(stage, { recursive: true, force: true }) }
    },
    async authenticate(value, signal) { validate(value); signal.throwIfAborted(); await readSkillBundleFiles(recipe, directory) },
    async check(value, signal) { validate(value); signal.throwIfAborted(); await readSkillBundleFiles(recipe, directory); signal.throwIfAborted(); return { authenticated: true, verification: 'local' } },
    async deactivate() {},
    async remove(value) { validate(value); await rm(dirname(directory), { recursive: true, force: true }) },
  }
}
