import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SKILL_CONNECTORS, SKILL_RECIPES, getSkillRecipe } from './skillCatalog.js'

const expectedFiles: Record<string, number> = { hyperframes: 61, obsidian: 12, drawio: 2, 'frontend-design': 2, 'canvas-design': 83, 'algorithmic-art': 4, 'webapp-testing': 6, 'mcp-builder': 10 }

test('skill bundles use fixed commits, unique safe file mappings and complete upstream payloads', () => {
  expect(SKILL_RECIPES).toHaveLength(8)
  expect(SKILL_CONNECTORS).toHaveLength(8)
  for (const recipe of SKILL_RECIPES) {
    expect(recipe.files).toHaveLength(expectedFiles[recipe.id]!)
    expect(recipe.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(recipe.repository).toMatch(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+$/)
    expect(recipe.license === 'MIT' || recipe.license === 'Apache-2.0').toBe(true)
    expect(new Set(recipe.files.map(file => file.target)).size).toBe(recipe.files.length)
    expect(recipe.files.some(file => /(?:^|\/)LICENSE(?:\.txt)?$/.test(file.target))).toBe(true)
    expect(recipe.files.some(file => file.target.endsWith('/SKILL.md'))).toBe(true)
    for (const file of recipe.files) {
      expect(file.integrity).toMatch(/^sha256-[a-f0-9]{64}$/)
      for (const path of [file.source, file.target]) {
        expect(path).not.toMatch(/(^\/|\\|(^|\/)\.\.?($|\/)|[\x00-\x1f])/)
      }
      expect(file.target).toMatch(/^(skills\/[a-z0-9-]+\/.+|LICENSE(?:\.[a-z]+)?)$/)
      expect(file.target).not.toMatch(/(?:^|\/)(?:hooks|\.app\.json|\.mcp\.json)(?:\/|$)/)
    }
    const def = SKILL_CONNECTORS.find(item => item.id === recipe.id)!
    expect(def).toMatchObject({ collection: 'tools', transport: 'skills', region: 'global', version: recipe.version, pluginId: `office-${recipe.id}@haha-connectors` })
    expect(def.setupFields).toBeUndefined()
    expect(def.requirements).toBeTruthy()
    const icon = readFileSync(new URL(`../../../desktop/public/connectors/${recipe.id}.svg`, import.meta.url), 'utf8')
    expect(icon).toContain('<svg')
    expect(icon).not.toMatch(/<script|\son\w+\s*=|(?:href|src)=["']https?:/i)
    expect(getSkillRecipe(recipe.id, recipe.version)).toEqual(recipe)
    expect(getSkillRecipe(recipe.id, '999.0.0')).toBeUndefined()
  }
})

test('skill bundles retain cross-skill routes, examples, scripts and font licenses', () => {
  const paths = (id: string) => getSkillRecipe(id)!.files.map(file => file.target)
  for (const name of ['hyperframes', 'hyperframes-cli', 'hyperframes-registry', 'gsap', 'website-to-hyperframes']) expect(paths('hyperframes')).toContain(`skills/${name}/SKILL.md`)
  for (let step = 1; step <= 7; step++) expect(paths('hyperframes').some(path => path.startsWith(`skills/website-to-hyperframes/references/step-${step}-`))).toBe(true)
  expect(paths('algorithmic-art')).toContain('skills/algorithmic-art/templates/viewer.html')
  expect(paths('algorithmic-art')).toContain('skills/algorithmic-art/templates/generator_template.js')
  expect(paths('webapp-testing')).toContain('skills/webapp-testing/scripts/with_server.py')
  expect(paths('mcp-builder')).toContain('skills/mcp-builder/scripts/requirements.txt')
  expect(paths('mcp-builder')).toContain('skills/mcp-builder/reference/evaluation.md')
  expect(paths('obsidian')).toContain('skills/obsidian-bases/references/FUNCTIONS_REFERENCE.md')
  expect(paths('canvas-design').filter(path => path.endsWith('-OFL.txt')).length).toBeGreaterThan(20)
  expect(paths('canvas-design').filter(path => path.endsWith('.ttf')).length).toBeGreaterThan(20)
})
