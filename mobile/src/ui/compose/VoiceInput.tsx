import { useEffect, useState } from 'react'
import { Linking, Pressable, View } from 'react-native'
import type { ComposerVoiceDictation } from '../../core/useVoiceDictation'
import { Text } from '../Text'
import { Icon, Mono, Spinner, useColors } from '../kit'

export function VoiceMicrophone({ blocked, onPress }: { blocked: boolean, onPress(): void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="语音输入"
      accessibilityState={{ disabled: blocked }}
      disabled={blocked}
      onPress={onPress}
      style={({ pressed }) => ({ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: blocked ? 0.35 : pressed ? 0.6 : 1 })}
    >
      <Icon name="mic" size={20} color={colors.ink2} strokeWidth={1.8} />
    </Pressable>
  )
}

export function voiceClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Moving history of actual microphone levels, without simulated waveform data. */
function VoiceTrace({ voice }: { voice: ComposerVoiceDictation }) {
  const colors = useColors()
  const [levels, setLevels] = useState<number[]>([])
  const [width, setWidth] = useState(80)
  const { phase, getLevel } = voice
  useEffect(() => {
    if (phase !== 'recording') return
    const timer = setInterval(() => {
      const measured = getLevel()
      const level = Number.isFinite(measured) ? Math.max(0, Math.min(1, measured)) : 0
      setLevels(previous => [...previous.slice(-63), level])
    }, 80)
    return () => clearInterval(timer)
  }, [getLevel, phase])
  const count = Math.max(1, Math.floor(width / 5))
  const values = Array.from({ length: count }, (_, index) => levels[levels.length - count + index] ?? 0)
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="麦克风音量"
      onLayout={event => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, minWidth: 20, height: 32, flexDirection: 'row', alignItems: 'center', overflow: 'hidden', gap: 2, opacity: voice.phase === 'transcribing' ? 0.45 : 1 }}
    >
      {values.map((level, index) => (
        <View key={index} style={{ width: 3, height: 2 + Math.pow(level, 0.65) * 26, borderRadius: 2, backgroundColor: colors.ink2 }} />
      ))}
    </View>
  )
}

export function VoiceRecordingBar({ voice, canSend }: { voice: ComposerVoiceDictation, canSend: boolean }) {
  const colors = useColors()
  const [now, setNow] = useState(Date.now)
  const { phase } = voice
  useEffect(() => {
    if (phase !== 'recording') return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [phase])
  const transcribing = voice.phase === 'transcribing'
  const starting = voice.phase === 'starting'
  const elapsed = voice.phase === 'recording' ? Math.max(0, (now - voice.startedAt) / 1000) : 0
  const remaining = Math.max(0, voice.limitSeconds - elapsed)
  const countingDown = voice.phase === 'recording' && remaining <= Math.min(15, voice.limitSeconds / 3)
  const label = starting ? '准备录音…' : transcribing ? (voice.sendRequested ? '转写后发送…' : '转写中…') : countingDown ? `剩余 ${voiceClock(Math.ceil(remaining))}` : voiceClock(elapsed)
  return (
    <View accessibilityLabel="语音录音控制" style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="取消语音输入" onPress={voice.cancel} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="x" size={20} color={colors.ink2} />
      </Pressable>
      <VoiceTrace voice={voice} />
      <Mono accessibilityLiveRegion="polite" style={{ fontSize: 12, color: countingDown ? colors.attn : colors.ink3 }}>{label}</Mono>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="停止录音并转成文字"
        accessibilityState={{ disabled: transcribing, busy: starting || transcribing }}
        disabled={transcribing}
        onPress={voice.stop}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        {starting || transcribing ? <Spinner size={16} /> : <Icon name="stop" size={14} color={colors.ink2} />}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="转写后发送"
        accessibilityState={{ disabled: !canSend || starting || voice.sendRequested, busy: transcribing && voice.sendRequested }}
        disabled={!canSend || starting || voice.sendRequested}
        onPress={voice.stopAndSend}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: !canSend || starting ? 0.35 : 1 }}
      >
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.btn, alignItems: 'center', justifyContent: 'center' }}>
          {transcribing && voice.sendRequested ? <Spinner size={16} color={colors.btnInk} /> : <Icon name="arrow-up" size={18} color={colors.btnInk} strokeWidth={2.4} />}
        </View>
      </Pressable>
    </View>
  )
}

export function VoiceFeedback({ voice, blocked, onError }: { voice: ComposerVoiceDictation, blocked: boolean, onError(message: string): void }) {
  const colors = useColors()
  if (!voice.issue && voice.pendingText === null) return null
  return (
    <View style={{ paddingHorizontal: 10, paddingVertical: 8, gap: 6 }}>
      {voice.issue ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text accessibilityRole="alert" style={{ flex: 1, fontSize: 13, lineHeight: 19, color: colors.err }}>{voice.issue.message}</Text>
          {voice.issue.code === 'permission' ? (
            <Pressable accessibilityRole="button" accessibilityLabel="打开麦克风权限设置" onPress={() => { void Linking.openSettings().catch(() => onError('无法打开系统设置，请手动允许麦克风权限。')) }} style={{ paddingVertical: 10 }}>
              <Text style={{ fontSize: 13, color: colors.run }}>设置</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel="关闭语音提示" onPress={voice.dismissIssue} hitSlop={10}>
            <Icon name="x" size={16} color={colors.ink3} />
          </Pressable>
        </View>
      ) : null}
      {voice.pendingText !== null ? (
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 12, color: colors.ink3 }}>转写完成，文字已保留</Text>
          <Text selectable style={{ fontSize: 14, lineHeight: 21, color: colors.ink }}>{voice.pendingText}</Text>
          <View style={{ flexDirection: 'row', gap: 20 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="插入转写文字" accessibilityState={{ disabled: blocked }} disabled={blocked} onPress={voice.insertPending} style={{ minHeight: 44, justifyContent: 'center', opacity: blocked ? 0.4 : 1 }}>
              <Text style={{ color: colors.run, fontSize: 14 }}>插入文字</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="丢弃转写文字" onPress={voice.dismissPending} style={{ minHeight: 44, justifyContent: 'center' }}>
              <Text style={{ color: colors.ink3, fontSize: 14 }}>取消</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  )
}
