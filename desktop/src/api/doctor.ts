import { api } from './client'

export type DoctorReportItem = {
  id: string
  label: string
  kind: 'json' | 'jsonl' | 'directory'
  scope: 'user' | 'project'
  path: string
  protected: boolean
  exists: boolean
  status: 'ok' | 'not_configured' | 'missing' | 'invalid_json' | 'invalid_jsonl' | 'invalid_schema' | 'unreadable'
  bytes: number
  entryCount?: number
  lineCount?: number
  invalidLineCount?: number
  error?: string
}

export type DoctorReport = {
  generatedAt: string
  items: DoctorReportItem[]
  protectedSkips: Array<{
    id: string
    path: string
    reason: 'protected'
  }>
  summary: {
    total: number
    protectedCount: number
    neutralCount: number
    missingCount: number
    invalidCount: number
  }
}

export const doctorApi = {
  report: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ report: DoctorReport }>(`/api/doctor/report${query}`, { timeout: 3_000 })
  },
}
