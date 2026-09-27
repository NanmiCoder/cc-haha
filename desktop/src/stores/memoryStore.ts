import { create } from 'zustand'
import { memoryApi } from '../api/memory'
import type { MemoryFile, MemoryFileDetail, MemoryProject } from '../types/memory'

function canSelectMemoryProject(project: MemoryProject): boolean {
  return project.exists || project.fileCount > 0
}

let projectsRequest = 0
let filesRequest = 0
let fileRequest = 0
let saveRequest = 0

function invalidateProjectContext() {
  filesRequest += 1
  fileRequest += 1
  saveRequest += 1
}

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
  openFile: (projectId: string, path: string) => Promise<boolean>
  updateDraft: (content: string) => void
  saveFile: () => Promise<boolean>
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
    const request = ++projectsRequest
    set({ isLoadingProjects: true, error: null })
    try {
      const { projects } = await memoryApi.listProjects(cwd)
      if (request !== projectsRequest) return
      const selectableProjects = projects.filter(canSelectMemoryProject)
      const current = selectableProjects.find((project) => project.isCurrent)
      const previousSelectedProjectId = get().selectedProjectId
      const selectedProjectId =
        previousSelectedProjectId && selectableProjects.some((project) => project.id === previousSelectedProjectId)
          ? previousSelectedProjectId
          : current?.id ?? selectableProjects[0]?.id ?? null
      if (selectedProjectId !== previousSelectedProjectId) {
        invalidateProjectContext()
      }
      set({
        projects,
        selectedProjectId,
        isLoadingProjects: false,
        ...(selectedProjectId === previousSelectedProjectId
          ? {}
          : {
              files: [],
              selectedFile: null,
              draftContent: '',
              lastSavedAt: null,
              isLoadingFiles: false,
              isLoadingFile: false,
              isSaving: false,
            }),
      })
    } catch (err) {
      if (request !== projectsRequest) return
      set({ error: (err as Error).message, isLoadingProjects: false })
    }
  },

  selectProject: (projectId) => {
    if (get().selectedProjectId === projectId) return
    invalidateProjectContext()
    set({
      selectedProjectId: projectId,
      files: [],
      selectedFile: null,
      draftContent: '',
      isLoadingFiles: false,
      isLoadingFile: false,
      isSaving: false,
      error: null,
      lastSavedAt: null,
    })
  },

  fetchFiles: async (projectId) => {
    const request = ++filesRequest
    set({ isLoadingFiles: true, error: null })
    try {
      const { files } = await memoryApi.listFiles(projectId)
      if (request !== filesRequest || get().selectedProjectId !== projectId) return
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
      if (request !== filesRequest || get().selectedProjectId !== projectId) return
      set({ error: (err as Error).message, isLoadingFiles: false })
    }
  },

  openFile: async (projectId, path) => {
    const request = ++fileRequest
    set({ isLoadingFile: true, error: null })
    try {
      const { file } = await memoryApi.readFile(projectId, path)
      if (
        request !== fileRequest ||
        get().selectedProjectId !== projectId
      ) {
        return false
      }
      set({
        selectedFile: file,
        draftContent: file.content,
        isLoadingFile: false,
        lastSavedAt: null,
      })
      return true
    } catch (err) {
      if (
        request !== fileRequest ||
        get().selectedProjectId !== projectId
      ) {
        return false
      }
      set({ error: (err as Error).message, isLoadingFile: false })
      return false
    }
  },

  updateDraft: (content) => set({ draftContent: content }),

  saveFile: async () => {
    const { selectedProjectId, selectedFile, draftContent, isSaving } = get()
    if (!selectedProjectId || !selectedFile || isSaving) return false
    const request = ++saveRequest
    const identity = `${selectedProjectId}\0${selectedFile.path}`
    set({ isSaving: true, error: null })
    try {
      const { file } = await memoryApi.saveFile({
        projectId: selectedProjectId,
        path: selectedFile.path,
        content: draftContent,
        expectedUpdatedAt: selectedFile.updatedAt,
        expectedBytes: selectedFile.bytes,
      })
      const current = get()
      if (
        request !== saveRequest ||
        !current.selectedFile ||
        `${current.selectedProjectId}\0${current.selectedFile.path}` !== identity
      ) {
        if (request === saveRequest) set({ isSaving: false })
        return false
      }
      set({
        selectedFile: {
          ...current.selectedFile,
          updatedAt: file.updatedAt,
          bytes: file.bytes,
          content: draftContent,
        },
        isSaving: false,
        lastSavedAt: file.updatedAt,
      })
      await get().fetchFiles(selectedProjectId)
      return true
    } catch (err) {
      if (request !== saveRequest) return false
      set({ error: (err as Error).message, isSaving: false })
      return false
    }
  },

  createFile: async (projectId, path, content) => {
    if (get().isSaving) return
    const request = ++saveRequest
    set({ isSaving: true, error: null })
    try {
      await memoryApi.saveFile({ projectId, path, content })
      if (request !== saveRequest) return
      set({ isSaving: false })
      await get().fetchFiles(projectId)
      await get().openFile(projectId, path)
    } catch (err) {
      if (request !== saveRequest) return
      set({ error: (err as Error).message, isSaving: false })
    }
  },
}))
