import { create } from 'zustand'
import { memoryApi } from '../api/memory'
import type { MemoryFile, MemoryFileDetail, MemoryProject } from '../types/memory'

type MemoryStore = {
  projects: MemoryProject[]
  files: MemoryFile[]
  selectedProjectId: string | null
  selectedFile: MemoryFileDetail | null
  draftContent: string
  isLoadingProjects: boolean
  isLoadingFiles: boolean
  isLoadingFile: boolean
  isSaving: boolean
  error: string | null
  lastSavedAt: string | null

  fetchProjects: (cwd?: string) => Promise<void>
  selectProject: (projectId: string) => void
  fetchFiles: (projectId: string) => Promise<void>
  openFile: (projectId: string, path: string) => Promise<void>
  updateDraft: (content: string) => void
  saveFile: () => Promise<void>
  createFile: (projectId: string, path: string, content: string) => Promise<void>
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  projects: [],
  files: [],
  selectedProjectId: null,
  selectedFile: null,
  draftContent: '',
  isLoadingProjects: false,
  isLoadingFiles: false,
  isLoadingFile: false,
  isSaving: false,
  error: null,
  lastSavedAt: null,

  fetchProjects: async (cwd) => {
    set({ isLoadingProjects: true, error: null })
    try {
      const { projects } = await memoryApi.listProjects(cwd)
      const current = projects.find((project) => project.isCurrent)
      const selectedProjectId =
        get().selectedProjectId && projects.some((project) => project.id === get().selectedProjectId)
          ? get().selectedProjectId
          : current?.id ?? projects[0]?.id ?? null
      set({ projects, selectedProjectId, isLoadingProjects: false })
    } catch (err) {
      set({ error: (err as Error).message, isLoadingProjects: false })
    }
  },

  selectProject: (projectId) => {
    set({
      selectedProjectId: projectId,
      files: [],
      selectedFile: null,
      draftContent: '',
      error: null,
      lastSavedAt: null,
    })
  },

  fetchFiles: async (projectId) => {
    set({ isLoadingFiles: true, error: null })
    try {
      const { files } = await memoryApi.listFiles(projectId)
      set((state) => {
        const stillSelected = state.selectedFile && files.some((file) => file.path === state.selectedFile?.path)
        return {
          files,
          selectedFile: stillSelected ? state.selectedFile : null,
          draftContent: stillSelected ? state.draftContent : '',
          isLoadingFiles: false,
        }
      })
    } catch (err) {
      set({ error: (err as Error).message, isLoadingFiles: false })
    }
  },

  openFile: async (projectId, path) => {
    set({ isLoadingFile: true, error: null })
    try {
      const { file } = await memoryApi.readFile(projectId, path)
      set({
        selectedFile: file,
        draftContent: file.content,
        isLoadingFile: false,
        lastSavedAt: null,
      })
    } catch (err) {
      set({ error: (err as Error).message, isLoadingFile: false })
    }
  },

  updateDraft: (content) => set({ draftContent: content }),

  saveFile: async () => {
    const { selectedProjectId, selectedFile, draftContent } = get()
    if (!selectedProjectId || !selectedFile) return
    set({ isSaving: true, error: null })
    try {
      const { file } = await memoryApi.saveFile({
        projectId: selectedProjectId,
        path: selectedFile.path,
        content: draftContent,
      })
      set({
        selectedFile: {
          ...selectedFile,
          updatedAt: file.updatedAt,
          bytes: file.bytes,
          content: draftContent,
        },
        isSaving: false,
        lastSavedAt: file.updatedAt,
      })
      await get().fetchFiles(selectedProjectId)
    } catch (err) {
      set({ error: (err as Error).message, isSaving: false })
    }
  },

  createFile: async (projectId, path, content) => {
    set({ isSaving: true, error: null })
    try {
      await memoryApi.saveFile({ projectId, path, content })
      set({ isSaving: false })
      await get().fetchFiles(projectId)
      await get().openFile(projectId, path)
    } catch (err) {
      set({ error: (err as Error).message, isSaving: false })
    }
  },
}))
