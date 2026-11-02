import { expect, test } from 'bun:test'
import { isCommandVisible, isPluginIdVisible, isReferenceVisible } from './capabilityVisibility'

test('withdrawn managed packages stay out, same-named personal skills and other markets stay in', () => {
  expect(isPluginIdVisible('office-mcp-builder@haha-connectors')).toBe(false)
  expect(isPluginIdVisible('office-mcp-builder@mine')).toBe(true)
  expect(isPluginIdVisible('feishu@haha-connectors')).toBe(true)
  expect(isPluginIdVisible('')).toBe(true)
})

test('references: a plugin by its id, a skill by the plugin it comes from', () => {
  expect(isReferenceVisible({ kind: 'plugin', id: 'office-canvas-design@haha-connectors' })).toBe(false)
  expect(isReferenceVisible({ kind: 'skill', id: 'x', source: 'office-frontend-design@haha-connectors' })).toBe(false)
  expect(isReferenceVisible({ kind: 'skill', id: 'x', source: 'userSettings' })).toBe(true)
  expect(isReferenceVisible({ kind: 'skill', id: 'x' })).toBe(true)
})

test('slash commands: managed namespaces are hidden, user/project commands and agents never are', () => {
  expect(isCommandVisible({ name: 'office-algorithmic-art:generate' })).toBe(false)
  expect(isCommandVisible({ name: 'office-algorithmic-art:generate', source: 'user' })).toBe(true)
  expect(isCommandVisible({ name: 'office-algorithmic-art:generate', source: 'project' })).toBe(true)
  expect(isCommandVisible({ name: 'office-algorithmic-art', kind: 'agent' })).toBe(true)
  expect(isCommandVisible({ name: 'review' })).toBe(true)
  expect(isCommandVisible({ name: 'feishu:calendar' })).toBe(true)
})
