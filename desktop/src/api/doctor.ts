import { api } from './client'

export type DoctorReportItem = {
  id: string
  label: string
  kind: 'json' | 'jsonl' | 'directory'
  scope: 'user' | 'project'
  path: string
  protected: boolean
  exists: boolean
  status: 'ok' | 'missing' | 'invalid_json' | 'invalid_jsonl' | 'unreadable'
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
    missingCount: number
    invalidCount: number
  }
}

export type DoctorRepairResult = {
  dryRun: true
  mutated: false
  operations: Array<{
    id: string
    path: string
    action: 'would_repair'
  }>
  skips: Array<{
    id: string
    path: string
    reason: 'protected'
  }>
  summary: {
    operationCount: number
    skipCount: number
  }
}

export type DoctorReportRepairResponse = {
  ok: boolean
  report: DoctorReport
  repair: DoctorRepairResult
}

export const doctorApi = {
  report: () => api.get<{ report: DoctorReport }>('/api/doctor/report', { timeout: 3_000 }),
  repair: () => api.post<{ result: DoctorRepairResult }>('/api/doctor/repair', {}, { timeout: 3_000 }),
  reportAndRepair: async (): Promise<DoctorReportRepairResponse> => {
    const [{ report }, { result }] = await Promise.all([
      doctorApi.report(),
      doctorApi.repair(),
    ])

    return {
      ok: true,
      report,
      repair: result,
    }
  },
}
