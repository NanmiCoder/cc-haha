import { api } from './client'
import type { AdapterFileConfig } from '../types/adapter'

export type DingtalkRegistrationBegin = {
  deviceCode: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete: string
  expiresInSeconds: number
  intervalSeconds: number
  qrDataUrl?: string
}

export type DingtalkRegistrationPoll = {
  status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED' | 'UNKNOWN'
  failReason?: string
  config?: AdapterFileConfig
}

export type WhatsAppLoginStart = {
  sessionKey: string
  qrDataUrl?: string
  message: string
}

export type WhatsAppLoginPoll =
  | AdapterFileConfig
  | {
      connected: false
      status: 'waiting' | 'expired' | 'error'
      qrDataUrl?: string
      message: string
    }

export type FeishuRegistrationBegin = {
  sessionKey: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
  message: string
  qrDataUrl?: string
}

export type FeishuRegistrationPoll =
  | { status: 'success'; config: AdapterFileConfig }
  | { status: 'waiting'; intervalSeconds: number; message: string }
  | { status: 'expired' | 'denied' | 'failed' | 'not_started'; message: string }

export type QrLoginStart = {
  sessionKey: string
  verificationUrl: string
  pollIntervalMs: number
  message: string
  qrDataUrl?: string
}

export type QrLoginPoll =
  | AdapterFileConfig
  | {
      connected: false
      status: 'waiting' | 'expired' | 'failed' | 'not_started'
      message: string
      qrDataUrl?: string
    }

export type SlackManifestInfo = {
  manifest: string
  createAppUrl: string
}

export const adaptersApi = {
  getConfig() {
    return api.get<AdapterFileConfig>('/api/adapters')
  },

  updateConfig(patch: Partial<AdapterFileConfig>) {
    return api.put<AdapterFileConfig>('/api/adapters', patch)
  },

  startWechatLogin() {
    return api.post<{ qrcodeUrl?: string; message: string; sessionKey: string }>('/api/adapters/wechat/login/start', {})
  },

  pollWechatLogin(sessionKey: string) {
    return api.post<
      | AdapterFileConfig
      | { connected: false; status: string; message: string }
    >('/api/adapters/wechat/login/poll', { sessionKey }, { timeout: 45_000 })
  },

  unbindWechat() {
    return api.post<AdapterFileConfig>('/api/adapters/wechat/unbind', {})
  },

  unbindDingtalk() {
    return api.post<AdapterFileConfig>('/api/adapters/dingtalk/unbind', {})
  },

  beginDingtalkRegistration() {
    return api.post<DingtalkRegistrationBegin>('/api/adapters/dingtalk/registration/begin', {})
  },

  pollDingtalkRegistration(deviceCode: string) {
    return api.post<DingtalkRegistrationPoll>('/api/adapters/dingtalk/registration/poll', { deviceCode })
  },

  startWhatsAppLogin() {
    return api.post<WhatsAppLoginStart>('/api/adapters/whatsapp/login/start', {})
  },

  pollWhatsAppLogin(sessionKey: string) {
    return api.post<WhatsAppLoginPoll>('/api/adapters/whatsapp/login/poll', { sessionKey }, { timeout: 45_000 })
  },

  unbindWhatsApp() {
    return api.post<AdapterFileConfig>('/api/adapters/whatsapp/unbind', {})
  },

  beginFeishuRegistration() {
    return api.post<FeishuRegistrationBegin>('/api/adapters/feishu/registration/begin', {})
  },

  pollFeishuRegistration(sessionKey: string) {
    return api.post<FeishuRegistrationPoll>('/api/adapters/feishu/registration/poll', { sessionKey })
  },

  cancelFeishuRegistration(sessionKey: string) {
    return api.post<{ status: string }>('/api/adapters/feishu/registration/cancel', { sessionKey })
  },

  unbindFeishu() {
    return api.post<AdapterFileConfig>('/api/adapters/feishu/unbind', {})
  },

  startWecomLogin() {
    return api.post<QrLoginStart>('/api/adapters/wecom/login/start', {})
  },

  pollWecomLogin(sessionKey: string) {
    return api.post<QrLoginPoll>('/api/adapters/wecom/login/poll', { sessionKey }, { timeout: 45_000 })
  },

  unbindWecom() {
    return api.post<AdapterFileConfig>('/api/adapters/wecom/unbind', {})
  },

  startQqLogin() {
    return api.post<QrLoginStart>('/api/adapters/qq/login/start', {}, { timeout: 45_000 })
  },

  pollQqLogin(sessionKey: string) {
    return api.post<QrLoginPoll>('/api/adapters/qq/login/poll', { sessionKey }, { timeout: 45_000 })
  },

  unbindQq() {
    return api.post<AdapterFileConfig>('/api/adapters/qq/unbind', {})
  },

  getSlackManifest() {
    return api.get<SlackManifestInfo>('/api/adapters/slack/manifest')
  },

  unbindSlack() {
    return api.post<AdapterFileConfig>('/api/adapters/slack/unbind', {})
  },
}
