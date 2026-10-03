import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CONNECTORS } from '../services/connectors/catalog.js'
import type { ConnectorInstallation } from '../services/connectors/types.js'
import { renderNativeConnectorSkill } from '../services/connectors/nativeConnectorSkill.js'

type JsonObject = Record<string, unknown>

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  return value as JsonObject
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

/** Never follow a staged descendant link when editing the copied metadata. */
async function assertStagedPath(stage: string, file: string): Promise<void> {
  const root = resolve(stage)
  const target = resolve(file)
  if (!inside(root, target)) throw new Error('Storage metadata path escaped staging directory')
  let current = root
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error('Linked storage metadata cannot be migrated')
      if (current === target && (!info.isFile() || info.nlink !== 1)) throw new Error('Storage metadata must be a regular independent file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

async function optionalJson(stage: string, file: string): Promise<JsonObject | null> {
  await assertStagedPath(stage, file)
  try {
    return object(JSON.parse(await readFile(file, 'utf8')), 'storage metadata')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function saveFile(stage: string, file: string, content: string): Promise<void> {
  await assertStagedPath(stage, file)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { mode: 0o600, flush: true })
  await rename(temporary, file)
}

/** Transform only the private staged copy. Stored conversation bytes are never rewritten. */
export async function relocateManagedData(sourceDir: string, targetDir: string, stagedDir: string): Promise<void> {
  const source = resolve(sourceDir)
  const target = resolve(targetDir)
  const stage = resolve(stagedDir)
  const sourceRoots = [source]
  try {
    const canonical = await realpath(source)
    if (relative(source, canonical) !== '') sourceRoots.push(canonical)
  } catch (error) {
    // Offline recovery fixtures and metadata-only upgrades may no longer have
    // the old directory. The stored root still supplies its original mapping.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const rebase = (value: unknown): unknown => {
    if (typeof value !== 'string' || !isAbsolute(value)) return value
    const root = sourceRoots.find(candidate => inside(candidate, resolve(value)))
    return root ? join(target, relative(root, resolve(value))) : value
  }
  const stagedPath = (finalPath: string): string => {
    if (!inside(target, resolve(finalPath))) throw new Error('Managed connector path escaped migration target')
    return join(stage, relative(target, resolve(finalPath)))
  }
  const mappingPath = join(stage, 'cc-haha', 'storage-relocations.json')
  const mapping = await optionalJson(stage, mappingPath) ?? { version: 1, previousRoots: [] }
  if (mapping.version !== 1 || !Array.isArray(mapping.previousRoots) ||
    !mapping.previousRoots.every(root => typeof root === 'string' && isAbsolute(root) && !root.includes('\0'))) {
    throw new Error('Unsupported or invalid storage relocation metadata')
  }
  const roots = [...mapping.previousRoots as string[], ...sourceRoots]
  const previousRoots: string[] = []
  for (const root of roots) {
    const normalized = resolve(root)
    if (inside(target, normalized) || inside(normalized, target)) {
      throw new Error('Previous storage root overlaps the migration target')
    }
    const comparable = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (!previousRoots.some(existing => (process.platform === 'win32' ? existing.toLowerCase() : existing) === comparable)) previousRoots.push(normalized)
  }

  const installations = new Map<string, { installation: ConnectorInstallation, version?: string }>()
  const connectorPath = join(stage, 'connectors', 'state.json')
  const connectorState = await optionalJson(stage, connectorPath)
  if (connectorState) {
    if (connectorState.schemaVersion !== undefined && connectorState.schemaVersion !== 0 && connectorState.schemaVersion !== 1) {
      throw new Error('Unsupported connector state version')
    }
    const records = object(connectorState.connectors, 'connector records')
    for (const [id, value] of Object.entries(records)) {
      const record = object(value, 'connector record')
      if (!record.installation) continue
      const installation = object(record.installation, 'connector installation')
      if (typeof installation.directory !== 'string' || typeof installation.command !== 'string' ||
        !Array.isArray(installation.args) || !installation.args.every(arg => typeof arg === 'string')) {
        throw new Error('Invalid connector installation paths')
      }
      const env = object(installation.env, 'connector installation environment')
      installation.directory = rebase(installation.directory)
      installation.command = rebase(installation.command)
      installation.args = installation.args.map(rebase)
      for (const key of ['DWS_CONFIG_DIR', 'DWS_KEYCHAIN_DIR']) {
        if (env[key] !== undefined && typeof env[key] !== 'string') throw new Error('Invalid connector account path')
        if (env[key] !== undefined) env[key] = rebase(env[key])
      }
      installations.set(id, {
        installation: installation as ConnectorInstallation,
        version: typeof record.installedVersion === 'string' ? record.installedVersion : undefined,
      })
    }
    await saveFile(stage, connectorPath, JSON.stringify(connectorState, null, 2) + '\n')
  }

  const ownedSkills = new Map<string, string>()
  for (const folder of ['plugins', 'cowork_plugins']) {
    const marketplacesPath = join(stage, folder, 'known_marketplaces.json')
    const marketplaces = await optionalJson(stage, marketplacesPath)
    if (marketplaces) {
      for (const value of Object.values(marketplaces)) {
        const entry = object(value, 'marketplace')
        if (typeof entry.installLocation !== 'string') throw new Error('Invalid marketplace install location')
        entry.installLocation = rebase(entry.installLocation)
        const location = object(entry.source, 'marketplace source')
        if (location.source === 'file' || location.source === 'directory') {
          if (typeof location.path !== 'string') throw new Error('Invalid local marketplace source')
          location.path = rebase(location.path)
        }
      }
      await saveFile(stage, marketplacesPath, JSON.stringify(marketplaces, null, 2) + '\n')
    }
    for (const filename of ['installed_plugins.json', 'installed_plugins_v2.json']) {
      const pluginsPath = join(stage, folder, filename)
      const plugins = await optionalJson(stage, pluginsPath)
      if (!plugins) continue
      if (plugins.version !== undefined && plugins.version !== 1 && plugins.version !== 2) throw new Error('Unsupported installed plugins version')
      for (const [id, value] of Object.entries(object(plugins.plugins, 'installed plugins'))) {
        for (const item of Array.isArray(value) ? value : [value]) {
          const entry = object(item, 'installed plugin')
          if (typeof entry.installPath !== 'string') throw new Error('Invalid installed plugin path')
          entry.installPath = rebase(entry.installPath)
          const definition = CONNECTORS.find(def => def.pluginId === id)
          if (definition && inside(target, resolve(entry.installPath as string))) {
            ownedSkills.set(join(entry.installPath as string, 'skills', `office-${definition.id}`, 'SKILL.md'), definition.id)
          }
        }
      }
      await saveFile(stage, pluginsPath, JSON.stringify(plugins, null, 2) + '\n')
    }
  }
  for (const definition of CONNECTORS) {
    ownedSkills.set(join(target, 'connectors', 'marketplace', 'plugins', `office-${definition.id}`, 'skills', `office-${definition.id}`, 'SKILL.md'), definition.id)
  }
  for (const [finalPath, id] of ownedSkills) {
    const managed = installations.get(id)
    if (!managed || !inside(join(target, 'connectors'), resolve(managed.installation.directory))) continue
    const file = stagedPath(finalPath)
    await assertStagedPath(stage, file)
    try { await lstat(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const definition = CONNECTORS.find(def => def.id === id)!
    const version = managed.version ?? basename(managed.installation.directory).match(/^(.+)-(?:darwin|win32|linux)-(?:x64|arm64)$/)?.[1] ?? definition.version
    await saveFile(stage, file, renderNativeConnectorSkill({ ...definition, version }, managed.installation))
  }
  await saveFile(stage, mappingPath, JSON.stringify({ ...mapping, version: 1, previousRoots }, null, 2) + '\n')
}
