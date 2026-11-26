import { Pressable, View } from 'react-native'
import type { ComposerPromptOptimize } from '../../core/usePromptOptimize'
import { Text } from '../Text'
import { Icon, Spinner, useColors } from '../kit'
import { Glyph } from './glyphs'

export function PromptOptimizeButton({
  optimize,
  canOptimize,
}: {
  optimize: ComposerPromptOptimize
  canOptimize: boolean
}) {
  const colors = useColors()
  if (!canOptimize && !optimize.optimizing) return null

  if (optimize.optimizing) {
    return (
      <Pressable
        testID="prompt-optimize-button"
        accessibilityRole="button"
        accessibilityLabel="取消优化提示词"
        accessibilityState={{ busy: true }}
        onPress={optimize.cancel}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            backgroundColor: colors.runTint,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spinner size={16} color={colors.run} />
        </View>
      </Pressable>
    )
  }

  return (
    <Pressable
      testID="prompt-optimize-button"
      accessibilityRole="button"
      accessibilityLabel="优化提示词"
      accessibilityState={{ disabled: !canOptimize }}
      disabled={!canOptimize}
      onPress={optimize.optimize}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Glyph name="wand" size={19} color={colors.ink2} strokeWidth={1.8} />
    </Pressable>
  )
}

export function PromptOptimizeFeedback({
  optimize,
  blocked,
}: {
  optimize: ComposerPromptOptimize
  blocked: boolean
}) {
  const colors = useColors()
  const { optimizing, restoreSnapshot, notice, issue } = optimize
  if (!optimizing && !restoreSnapshot && !notice && !issue) return null

  return (
    <View testID="prompt-optimize-feedback" style={{ paddingHorizontal: 10, paddingVertical: 4, gap: 6 }}>
      {optimizing ? (
        <View style={{ minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Spinner size={13} color={colors.run} />
          <Text
            accessibilityLiveRegion="polite"
            style={{ flex: 1, fontSize: 13, lineHeight: 18, color: colors.run }}
          >
            正在结合上下文优化提示词…
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="取消优化"
            onPress={optimize.cancel}
            hitSlop={10}
            style={({ pressed }) => ({
              minHeight: 36,
              justifyContent: 'center',
              paddingHorizontal: 6,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontSize: 13, color: colors.ink3 }}>取消</Text>
          </Pressable>
        </View>
      ) : null}

      {restoreSnapshot && !optimizing ? (
        <View
          testID="prompt-optimize-restore"
          style={{
            minHeight: 36,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 10,
            borderRadius: 12,
            backgroundColor: colors.fill,
          }}
        >
          <Icon name="check" size={14} color={colors.ok} strokeWidth={2.2} />
          <Text
            accessibilityLiveRegion="polite"
            style={{ flex: 1, fontSize: 13, lineHeight: 18, color: colors.ink2 }}
          >
            提示词已优化
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="还原优化前的提示词"
            accessibilityState={{ disabled: blocked }}
            disabled={blocked}
            onPress={optimize.restore}
            hitSlop={8}
            style={({ pressed }) => ({
              minHeight: 36,
              justifyContent: 'center',
              paddingHorizontal: 6,
              opacity: blocked ? 0.4 : pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.run }}>还原</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭优化提示"
            onPress={optimize.dismissRestore}
            hitSlop={10}
            style={{ minHeight: 36, justifyContent: 'center' }}
          >
            <Icon name="x" size={15} color={colors.ink3} />
          </Pressable>
        </View>
      ) : null}

      {notice && !optimizing && !restoreSnapshot ? (
        <View style={{ minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text
            accessibilityLiveRegion="polite"
            style={{ flex: 1, fontSize: 13, lineHeight: 18, color: colors.ink3 }}
          >
            {notice}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭提示词优化状态"
            onPress={optimize.dismissNotice}
            hitSlop={10}
          >
            <Icon name="x" size={15} color={colors.ink3} />
          </Pressable>
        </View>
      ) : null}

      {issue ? (
        <View style={{ minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text
            accessibilityRole="alert"
            style={{ flex: 1, fontSize: 13, lineHeight: 19, color: colors.err }}
          >
            {issue.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭提示词优化错误"
            onPress={optimize.dismissIssue}
            hitSlop={10}
          >
            <Icon name="x" size={16} color={colors.ink3} />
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}
