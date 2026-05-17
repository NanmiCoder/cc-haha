export type MemoryProject = {
  id: string
  label: string
  memoryDir: string
  exists: boolean
  fileCount: number
  isCurrent: boolean
}

export type MemoryFile = {
  path: string
  name: string
  bytes: number
  updatedAt: string
  type?: string
  description?: string
  title: string
  isIndex: boolean
}

export type MemoryFileDetail = {
  path: string
  content: string
  updatedAt: string
  bytes: number
}
