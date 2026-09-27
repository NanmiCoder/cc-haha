import { describe, expect, it } from 'vitest'
import { isComposerPluginVisible, isComposerReferenceVisible, isComposerSlashCommandVisible } from './composerCapabilityVisibility'
import type { ComposerReferenceCandidate } from '@/types/composerReference'

const reference = (kind: 'skill' | 'plugin', id: string, source: string): ComposerReferenceCandidate => ({ kind, id, source, name: id, displayName: id, description: '', modelText: '' })

describe('withdrawn managed packages in composer discovery', () => {
  it.each(['frontend-design', 'canvas-design', 'algorithmic-art', 'webapp-testing', 'mcp-builder'])('hides %s through references, plugin entries and CLI slash namespaces', name => {
    const id = `office-${name}@haha-connectors`
    expect(isComposerPluginVisible(id)).toBe(false)
    expect(isComposerReferenceVisible(reference('plugin', id, id))).toBe(false)
    expect(isComposerReferenceVisible(reference('skill', `office-${name}:${name}`, id))).toBe(false)
    expect(isComposerSlashCommandVisible({ name: id, description: '', kind: 'plugin' })).toBe(false)
    expect(isComposerSlashCommandVisible({ name: `office-${name}:${name}`, description: '', kind: 'skill', source: 'plugin' })).toBe(false)
    expect(isComposerSlashCommandVisible({ name: `office-${name}:${name}`, description: '' })).toBe(false)
    expect(isComposerReferenceVisible(reference('skill', name, 'user'))).toBe(true)
    expect(isComposerReferenceVisible(reference('skill', name, 'project'))).toBe(true)
    expect(isComposerSlashCommandVisible({ name, description: '', kind: 'skill', source: 'user' })).toBe(true)
  })

  it('does not hide unrelated packages, similar namespaces or personal namespaced skills', () => {
    for (const id of ['office-hyperframes@haha-connectors', 'office-drawio@haha-connectors', 'office-obsidian@haha-connectors', 'office-frontend-design@another-market']) {
      expect(isComposerReferenceVisible(reference('plugin', id, id))).toBe(true)
    }
    for (const name of ['frontend-design', 'office-frontend-design-extra:design', 'office-frontend-design']) {
      expect(isComposerSlashCommandVisible({ name, description: '' })).toBe(true)
    }
    expect(isComposerSlashCommandVisible({ name: 'office-frontend-design:design', source: 'project', description: '' })).toBe(true)
  })
})
