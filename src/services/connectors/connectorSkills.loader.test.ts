import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getCommandName } from '../../types/command.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { loadPluginSkillsFromEnabledPlugins } from '../../utils/plugins/loadPluginCommands.js'
import { CONNECTORS } from './catalog.js'
import { defaultRuntimeDependencies, managedInstallation } from './managedRuntime.js'
import { renderConnectorSkill } from './pluginBridge.js'
import { getSkillRecipe, SKILL_CONNECTORS } from './skillCatalog.js'

// Use the real catalog paths and generated connector entry points, but synthetic
// upstream content: this exercises the chat's loader without downloads or login.
for (const definition of [...CONNECTORS, ...SKILL_CONNECTORS]) {
  test(`${definition.id} exposes its connector entry and declared skills to fresh and refreshed chat loaders`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'connector-loader-'))
    try {
      const name = `office-${definition.id}`
      const skillsPath = join(root, 'skills')
      const wrapper = join(skillsPath, name, 'SKILL.md')
      const installation = definition.transport === 'skills'
        ? { directory: root, command: '', args: [], env: {} }
        : managedInstallation(definition, root, { ...defaultRuntimeDependencies, platform: 'darwin', arch: 'arm64' })
      await mkdir(dirname(wrapper), { recursive: true })
      await writeFile(wrapper, renderConnectorSkill(definition, installation))
      const upstream = getSkillRecipe(definition.id)?.files
        .filter(file => /^skills\/[^/]+\/SKILL.md$/.test(file.target)) ?? []
      for (const file of upstream) {
        const path = join(root, file.target)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, '---\ndescription: Synthetic upstream workflow\n---\nUse this fixture.\n')
      }
      const plugin: LoadedPlugin = {
        name, manifest: { name, version: definition.version, skills: './skills' },
        path: root, source: definition.pluginId, repository: definition.pluginId,
        skillsPath,
      }
      const fresh = await loadPluginSkillsFromEnabledPlugins([plugin])
      const entry = fresh.find(skill => skill.name === `${name}:${name}`)
      expect(entry).toBeDefined()
      expect(getCommandName(entry!)).toBe(`${name}:${name}`)
      expect(entry?.type === 'prompt' && entry.disableModelInvocation).toBe(false)
      expect(fresh.map(skill => skill.name).sort()).toEqual([
        `${name}:${name}`,
        ...upstream.map(file => `${name}:${file.target.split('/')[1]}`),
      ].sort())

      // A session reload receives the newly enabled plugin set. No old skill
      // commands may survive disablement; enabling again reloads current files.
      expect(await loadPluginSkillsFromEnabledPlugins([])).toEqual([])
      await writeFile(wrapper, renderConnectorSkill(definition, installation)
        .replace(/^description:.*$/m, 'description: Refreshed connector fixture'))
      const refreshed = await loadPluginSkillsFromEnabledPlugins([plugin])
      expect(refreshed.find(skill => skill.name === `${name}:${name}`)?.description)
        .toBe('Refreshed connector fixture')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
