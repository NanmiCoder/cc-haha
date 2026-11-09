import { NativeModules } from 'react-native'
import { classifyPath, type RtcChannel, type RtcFactory } from './peer'

/**
 * react-native-webrtc 包成直连用的那一小部分接口。原生模块不在（旧安装包）时
 * 返回 undefined，整个 App 照常只走 Cloudflare，不会因为少一个模块崩溃。
 */
export function nativeRtc(): RtcFactory | undefined {
  if (!NativeModules.WebRTCModule) return undefined
  let webrtc: typeof import('react-native-webrtc')
  try {
    // Loaded lazily on purpose: a binary without the native module must keep working.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    webrtc = require('react-native-webrtc')
  } catch {
    return undefined
  }
  return (config) => {
    const pc = new webrtc.RTCPeerConnection({ iceServers: config.iceServers as never })
    const events = pc as unknown as { addEventListener(type: string, listener: (event: any) => void): void }
    const channel = (label: string, id: number): RtcChannel => {
      const dc = pc.createDataChannel(label, { negotiated: true, id, ordered: true })
      const target = dc as unknown as { addEventListener(type: string, listener: (event: any) => void): void }
      return {
        get readyState() {
          return dc.readyState
        },
        send: (text: string) => dc.send(text),
        close: () => dc.close(),
        on: (event: string, listener: (data?: unknown) => void) =>
          target.addEventListener(event, (payload) => (event === 'message' ? listener(payload.data) : listener())),
      } as RtcChannel
    }
    return {
      createChannel: (label, id) => channel(label, id),
      async createOffer() {
        const offer = await pc.createOffer({})
        await pc.setLocalDescription(offer)
        return pc.localDescription?.sdp ?? offer.sdp
      },
      async setAnswer(sdp) {
        await pc.setRemoteDescription(new webrtc.RTCSessionDescription({ type: 'answer', sdp }))
      },
      async addCandidate(candidate) {
        await pc.addIceCandidate(new webrtc.RTCIceCandidate({ candidate, sdpMLineIndex: 0, sdpMid: '0' }))
      },
      onCandidate: (listener) =>
        events.addEventListener('icecandidate', (event) => listener(event.candidate ? String(event.candidate.candidate) : null)),
      onState: (listener) => events.addEventListener('connectionstatechange', () => listener(pc.connectionState)),
      async selectedPath() {
        const stats = (await pc.getStats()) as unknown as Map<string, Record<string, unknown>>
        let local: string | undefined
        let remote: string | undefined
        stats.forEach((report) => {
          if (report.type !== 'candidate-pair' || report.state !== 'succeeded' || !report.nominated) return
          const pick = (id: unknown) => {
            const candidate = stats.get(String(id))
            return (candidate?.address ?? candidate?.ip) as string | undefined
          }
          local = pick(report.localCandidateId)
          remote = pick(report.remoteCandidateId)
        })
        return classifyPath(local, remote)
      },
      close: () => pc.close(),
    }
  }
}
