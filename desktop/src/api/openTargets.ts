import { api, getApiUrl } from './client'

export type OpenTargetKind = 'ide' | 'file_manager'

export type OpenTarget = {
  id: string
  kind: OpenTargetKind
  label: string
  icon: string
  iconUrl?: string
  platform: string
}

export type OpenTargetList = {
  platform: string
  targets: OpenTarget[]
  primaryTargetId: string | null
  cachedAt: number
  ttlMs: number
}

export type OpenTargetOpenResponse = {
  ok: true
  targetId: string
  path: string
}

function normalizeOpenTargetList(result: OpenTargetList): OpenTargetList {
  return {
    ...result,
    targets: result.targets.map((target) => ({
      ...target,
      iconUrl: target.iconUrl ? getApiUrl(target.iconUrl) : undefined,
    })),
  }
}

export const openTargetsApi = {
  async list() {
    return normalizeOpenTargetList(await api.get<OpenTargetList>('/api/open-targets'))
  },
  open(targetId: string, path: string) {
    return api.post<OpenTargetOpenResponse>('/api/open-targets/open', { targetId, path })
  },
}
