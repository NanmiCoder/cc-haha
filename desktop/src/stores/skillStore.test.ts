import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogSkill, SkillMeta } from '../types/skill'

const { listMock, catalogMock, installMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  catalogMock: vi.fn(),
  installMock: vi.fn(),
}))

vi.mock('../api/skills', () => ({
  skillsApi: {
    list: listMock,
    detail: vi.fn(),
    catalog: catalogMock,
    install: installMock,
  },
}))

import { useSkillStore } from './skillStore'

const catalogEntry: CatalogSkill = {
  name: 'coderabbit-review',
  displayName: 'CodeRabbit Review',
  description: 'Run CodeRabbit review',
  category: 'Code Review',
  source: 'openai/plugins (MIT)',
  installed: false,
}

const installedMeta: SkillMeta = {
  name: 'coderabbit-review',
  description: 'Run CodeRabbit review',
  source: 'user',
  userInvocable: true,
  contentLength: 100,
  hasDirectory: true,
}

describe('skillStore catalog + install', () => {
  beforeEach(() => {
    listMock.mockReset()
    catalogMock.mockReset()
    installMock.mockReset()
    useSkillStore.setState({
      skills: [],
      catalog: [],
      installingName: null,
      error: null,
      isCatalogLoading: false,
    })
  })

  it('fetchCatalog populates the catalog', async () => {
    catalogMock.mockResolvedValue({ catalog: [catalogEntry] })

    await useSkillStore.getState().fetchCatalog()

    expect(catalogMock).toHaveBeenCalledTimes(1)
    expect(useSkillStore.getState().catalog).toEqual([catalogEntry])
    expect(useSkillStore.getState().isCatalogLoading).toBe(false)
  })

  it('installSkill installs then refreshes catalog and installed skills, clearing installingName', async () => {
    installMock.mockResolvedValue({ ok: true, installed: true })
    catalogMock.mockResolvedValue({ catalog: [{ ...catalogEntry, installed: true }] })
    listMock.mockResolvedValue({ skills: [installedMeta] })

    await useSkillStore.getState().installSkill('coderabbit-review', '/work/dir')

    expect(installMock).toHaveBeenCalledWith('coderabbit-review')
    expect(catalogMock).toHaveBeenCalledTimes(1)
    expect(listMock).toHaveBeenCalledWith('/work/dir')

    const state = useSkillStore.getState()
    expect(state.installingName).toBeNull()
    expect(state.catalog[0]?.installed).toBe(true)
    expect(state.skills).toEqual([installedMeta])
  })

  it('installSkill records an error and clears installingName when the request fails', async () => {
    installMock.mockRejectedValue(new Error('disk full'))

    await useSkillStore.getState().installSkill('coderabbit-review')

    const state = useSkillStore.getState()
    expect(state.error).toBe('disk full')
    expect(state.installingName).toBeNull()
    expect(catalogMock).not.toHaveBeenCalled()
  })
})
