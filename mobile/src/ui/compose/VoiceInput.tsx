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
  const [width, setWidth] = useState(280)
  const { phase, getLevel } = voice
  useEffect(() => {
    if (phase !== 'recording') return
    const timer = setInterval(() => {
      const measured = getLevel()
      const level = Number.isFinite(measured) ? Math.max(0, Math.min(1, measured)) : 0
      setLevels(previous => [...previous.slice(-119), level])
    }, 80)
    return () => clearInterval(timer)
  }, [getLevel, phase])
  const count = Math.max(1, Math.min(120, Math.floor((width + 2) / 6)))
  const values = Array.from({ length: count }, (_, index) => levels[levels.length - count + index] ?? 0)
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={phase === 'transcribing' ? '已录制的声音波形' : '麦克风音量'}
      onLayout={event => setWidth(event.nativeEvent.layout.width)}
      style={{ height: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', overflow: 'hidden', gap: 2, opacity: phase === 'transcribing' ? 0.45 : 1 }}
    >
      {values.map((level, index) => (
        <View
          key={index}
          testID="voice-wave-bar"
          style={{
            width: 4,
            height: 3 + Math.pow(level, 0.65) * 61,
            borderRadius: 2,
            backgroundColor: colors.run,
            opacity: 0.2 + 0.8 * (index / Math.max(1, count - 1)),
          }}
        />
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
  const elapsed = starting ? 0 : Math.max(0, (now - voice.startedAt) / 1000)
  const remaining = Math.max(0, voice.limitSeconds - elapsed)
  const countingDown = phase === 'recording' && voice.limitSeconds > 0 && remaining <= Math.min(15, voice.limitSeconds / 3)
  const label = starting ? '准备麦克风…' : transcribing ? (voice.sendRequested ? '转写后发送…' : '正在转成文字…') : '正在聆听'
  return (
    <View testID="voice-recording-panel" accessibilityLabel="语音录音控制" style={{ padding: 10, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {starting || transcribing
            ? <Spinner size={14} color={colors.run} />
            : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.run }} />}
          <Text accessibilityLiveRegion="polite" style={{ flexShrink: 1, fontSize: 14, lineHeight: 20, fontWeight: '500', color: colors.run }}>{label}</Text>
        </View>
        <Mono style={{ fontSize: 13, color: countingDown ? colors.attn : colors.ink3 }}>
          {countingDown ? `剩余 ${voiceClock(Math.ceil(remaining))}` : voiceClock(elapsed)}
        </Mono>
      </View>
      <View style={{ paddingHorizontal: 12, borderRadius: 14, backgroundColor: colors.runTint }}>
        <VoiceTrace voice={voice} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="取消语音输入"
          onPress={voice.cancel}
          style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.fill, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
        >
          <Icon name="x" size={20} color={colors.ink2} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="停止录音并转成文字"
          accessibilityHint="转写文字会放回输入框，可以编辑后再发送"
          accessibilityState={{ disabled: starting || transcribing, busy: starting || transcribing }}
          disabled={starting || transcribing}
          onPress={voice.stop}
          style={({ pressed }) => ({ flex: 1, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 22, backgroundColor: colors.fill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: starting || transcribing ? 0.5 : pressed ? 0.6 : 1 })}
        >
          <Icon name="check" size={18} color={colors.ink} />
          <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: '500', color: colors.ink }}>完成</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="转写后发送"
          accessibilityState={{ disabled: !canSend || starting || voice.sendRequested, busy: transcribing && voice.sendRequested }}
          disabled={!canSend || starting || voice.sendRequested}
          onPress={voice.stopAndSend}
          style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.btn, alignItems: 'center', justifyContent: 'center', opacity: !canSend || starting ? 0.35 : pressed ? 0.7 : 1 })}
        >
          {transcribing && voice.sendRequested ? <Spinner size={16} color={colors.btnInk} /> : <Icon name="arrow-up" size={20} color={colors.btnInk} strokeWidth={2.4} />}
        </Pressable>
      </View>
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
