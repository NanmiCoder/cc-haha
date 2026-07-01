import { create } from 'zustand'
import { skillsApi } from '../api/skills'
import type { SkillMeta, SkillDetail, CatalogSkill } from '../types/skill'

export type SkillDetailReturnTab = 'skills' | 'plugins'

type SkillStore = {
  skills: SkillMeta[]
  selectedSkill: SkillDetail | null
  selectedSkillReturnTab: SkillDetailReturnTab
  isLoading: boolean
  isDetailLoading: boolean
  error: string | null

  catalog: CatalogSkill[]
  isCatalogLoading: boolean
  installingName: string | null

  fetchSkills: (cwd?: string) => Promise<void>
  fetchSkillDetail: (
    source: string,
    name: string,
    cwd?: string,
    returnTab?: SkillDetailReturnTab,
  ) => Promise<void>
  fetchCatalog: () => Promise<void>
  installSkill: (name: string, cwd?: string) => Promise<void>
  clearSelection: () => void
}

export const useSkillStore = create<SkillStore>((set, get) => ({
  skills: [],
  selectedSkill: null,
  selectedSkillReturnTab: 'skills',
  isLoading: false,
  isDetailLoading: false,
  error: null,

  catalog: [],
  isCatalogLoading: false,
  installingName: null,

  fetchSkills: async (cwd) => {
    set({ isLoading: true, error: null })
    try {
      const { skills } = await skillsApi.list(cwd)
      set({ skills, isLoading: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        isLoading: false,
      })
    }
  },

  fetchSkillDetail: async (source, name, cwd, returnTab = 'skills') => {
    set({ isDetailLoading: true, error: null })
    try {
      const { detail } = await skillsApi.detail(source, name, cwd)
      set({
        selectedSkill: detail,
        selectedSkillReturnTab: returnTab,
        isDetailLoading: false,
      })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        isDetailLoading: false,
      })
    }
  },

  fetchCatalog: async () => {
    set({ isCatalogLoading: true })
    try {
      const { catalog } = await skillsApi.catalog()
      set({ catalog, isCatalogLoading: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        isCatalogLoading: false,
      })
    }
  },

  installSkill: async (name, cwd) => {
    set({ installingName: name, error: null })
    try {
      await skillsApi.install(name)
      // Refresh both the installable catalog and the installed-skills list so
      // the newly installed skill appears and its catalog card flips to installed.
      await Promise.all([get().fetchCatalog(), get().fetchSkills(cwd)])
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      set({ installingName: null })
    }
  },

  clearSelection: () => set({ selectedSkill: null, selectedSkillReturnTab: 'skills' }),
}))
