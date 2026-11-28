import { useEffect, useRef } from 'react'
import { Alert, Linking, Pressable, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { useAndroidUpdate } from '../../state/AndroidUpdateContext'
import type { UpdateActionKind, UpdateSource } from '../../core/androidUpdateModel'
import {
  Button,
  Callout,
  Group,
  Icon,
  ListRow,
  Mono,
  Separator,
  Spinner,
  useColors,
} from '../kit'
import { Text } from '../Text'

/** 设置页顶部轻量提示行：仅在有可执行更新状态时出现，点击滚到底部「关于」更新区。 */
export function AndroidUpdateNotice({ onPress }: { onPress(): void }) {
  const colors = useColors()
  const { supported, viewModel } = useAndroidUpdate()
  if (!supported || !viewModel?.topNotice) return null
  const notice = viewModel.topNotice
  const tone =
    notice.tone === 'ok'
      ? { bg: colors.okSoft, fg: colors.ok }
      : notice.tone === 'attn'
        ? { bg: colors.attnSoft, fg: colors.attn }
        : { bg: colors.runSoft, fg: colors.run }

  return (
    <Group style={{ marginBottom: 16 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${notice.title}，${notice.subtitle}`}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: 64,
          paddingHorizontal: 14,
          paddingVertical: 11,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: pressed ? colors.fill : 'transparent',
        })}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 11,
            backgroundColor: tone.bg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {notice.spinning ? (
            <Spinner size={16} color={tone.fg} />
          ) : (
            <Icon name={notice.icon} size={18} color={tone.fg} strokeWidth={2} />
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.ink }}>
            {notice.title}
          </Text>
          {notice.monoSubtitle ? (
            <Mono numberOfLines={1} style={{ fontSize: 12.5, lineHeight: 17, color: colors.ink3 }}>
              {notice.subtitle}
            </Mono>
          ) : (
            <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
              {notice.subtitle}
            </Text>
          )}
        </View>
        <Icon name="chevron-right" size={16} color={colors.chevron} strokeWidth={2} />
      </Pressable>
    </Group>
  )
}

/** 嵌入「关于」分组的 Android 应用内更新行与按需展开面板。 */
export function AndroidUpdateAboutItem({
  onCopied,
  onLinkError,
}: {
  onCopied(message: string): void
  onLinkError(message: string): void
}) {
  const colors = useColors()
  const update = useAndroidUpdate()

  const { supported, setSettingsFocused } = update
  const downloadStartGuardRef = useRef(false)

  useEffect(() => {
    if (!supported) return
    setSettingsFocused(true)
    return () => setSettingsFocused(false)
  }, [supported, setSettingsFocused])

  if (!update.supported || !update.viewModel) return null
  const vm = update.viewModel

  const valueColor =
    vm.rowTone === 'run'
      ? colors.run
      : vm.rowTone === 'ok'
        ? colors.ok
        : vm.rowTone === 'attn'
          ? colors.attn
          : vm.rowTone === 'err'
            ? colors.err
            : colors.ink3

  async function startDownloadWithCellularGuard(source: UpdateSource) {
    if (downloadStartGuardRef.current) return
    downloadStartGuardRef.current = true
    try {
      const warn = await update.shouldWarnCellular()
      if (!warn) {
        await update.download(source)
        return
      }
      const sizeText = vm.sizeBadge ? `安装包约 ${vm.sizeBadge}，` : ''
      Alert.alert('当前使用移动网络', `${sizeText}继续下载将消耗移动数据流量。`, [
        { text: '取消', style: 'cancel' },
        { text: '继续下载', onPress: () => void update.download(source) },
      ])
    } finally {
      downloadStartGuardRef.current = false
    }
  }

  async function openExternal(url: string) {
    try {
      await Linking.openURL(url)
    } catch {
      onLinkError('无法打开系统浏览器，可复制下载链接手动打开。')
    }
  }

  async function copyDownloadLink(url: string) {
    try {
      await Clipboard.setStringAsync(url)
      onCopied('已复制下载链接')
    } catch {
      onLinkError('复制失败，请稍后重试。')
    }
  }

  function handleAction(kind: UpdateActionKind) {
    switch (kind) {
      case 'check':
        void update.checkForUpdates({ preferDesktop: false })
        return
      case 'checkDirectOnly':
        void update.checkForUpdates({ preferDesktop: false, directOnly: true })
        return
      case 'checkDesktop':
        void update.checkForUpdates({ preferDesktop: true })
        return
      case 'downloadDirect':
        void startDownloadWithCellularGuard('github')
        return
      case 'downloadDesktop':
        void startDownloadWithCellularGuard('desktop')
        return
      case 'cancelDownload':
        void update.cancelDownload()
        return
      case 'install':
        void update.install()
        return
      case 'deleteApk':
        void update.deleteDownloadedApk()
        return
      case 'openUnknownSources':
        void update.openUnknownSourcesSettings()
        return
      case 'retryInstallAfterPermission':
        void update.retryInstallAfterPermission()
        return
      case 'dismiss':
        void update.dismissAvailableVersion()
        return
      case 'openBrowser':
        void openExternal(vm.browserUrl)
        return
      case 'copyLink':
        void copyDownloadLink(vm.copyUrl)
        return
    }
  }

  return (
    <>
      <Separator />
      <ListRow
        title="检查更新"
        accessibilityLabel={vm.rowValue ? `检查更新，${vm.rowValue}` : '检查更新'}
        value={
          vm.rowValue ? (
            <Text
              numberOfLines={1}
              style={{
                fontSize: 15,
                color: valueColor,
                fontWeight: vm.rowTone === 'muted' ? '400' : '500',
                flexShrink: 0,
              }}
            >
              {vm.rowValue}
            </Text>
          ) : undefined
        }
        trailing={
          vm.rowChecking ? (
            <Spinner size={15} color={colors.ink3} />
          ) : vm.expanded ? undefined : (
            <Icon name="chevron-right" size={16} color={colors.chevron} strokeWidth={2} />
          )
        }
        onPress={vm.rowPressable ? () => void update.checkForUpdates({ preferDesktop: false }) : undefined}
      />

      {vm.expanded && (
        <>
          <Separator />
          <View style={{ padding: 14, gap: 12 }}>
            {vm.headline ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Text style={{ fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.ink, flex: 1 }}>
                  {vm.headline}
                </Text>
                {vm.sizeBadge ? (
                  <View
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 2,
                      borderRadius: 6,
                      backgroundColor: colors.fill,
                    }}
                  >
                    <Mono style={{ fontSize: 12, lineHeight: 16, color: colors.ink2 }}>
                      {vm.sizeBadge}
                    </Mono>
                  </View>
                ) : null}
              </View>
            ) : null}

            {vm.progressPercent !== null || vm.progressMeta ? (
              <View style={{ gap: 6 }}>
                <View
                  style={{
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: colors.fill,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      height: '100%',
                      borderRadius: 3,
                      backgroundColor: colors.run,
                      width: vm.progressPercent !== null ? `${vm.progressPercent}%` : '35%',
                    }}
                  />
                </View>
                {vm.progressMeta ? (
                  <Mono style={{ fontSize: 12.5, lineHeight: 17, color: colors.ink3 }}>
                    {vm.progressMeta}
                  </Mono>
                ) : null}
              </View>
            ) : null}

            {vm.calloutText && vm.calloutTone ? (
              <Callout tone={vm.calloutTone}>{vm.calloutText}</Callout>
            ) : null}

            {vm.description ? (
              <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.ink2 }}>
                {vm.description}
              </Text>
            ) : null}

            {vm.note ? (
              <Text accessibilityLiveRegion="polite" style={{ fontSize: 13, lineHeight: 19, color: colors.ink3 }}>
                {vm.note}
              </Text>
            ) : null}

            {vm.actions.length > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                {vm.actions.map((action) => (
                  <Button
                    key={action.kind}
                    title={action.label}
                    variant={action.look}
                    style={{ height: 42, paddingHorizontal: 15 }}
                    onPress={() => handleAction(action.kind)}
                  />
                ))}
              </View>
            ) : null}

            {vm.showExternalLinks ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, paddingTop: 2 }}>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="在浏览器打开版本页"
                  onPress={() => void openExternal(vm.browserUrl)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    paddingVertical: 4,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Icon name="external-link" size={13} color={colors.ink3} strokeWidth={2} />
                  <Text style={{ fontSize: 13, color: colors.ink3 }}>在浏览器打开</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="复制安装包下载链接"
                  onPress={() => void copyDownloadLink(vm.copyUrl)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    paddingVertical: 4,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Icon name="copy" size={13} color={colors.ink3} strokeWidth={2} />
                  <Text style={{ fontSize: 13, color: colors.ink3 }}>复制链接</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </>
      )}
    </>
  )
}
