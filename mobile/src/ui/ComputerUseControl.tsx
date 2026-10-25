import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import type { ApiClient } from '../core/client'
import { loadComposerComputerUse, needsComputerPermission, openComputerPermissionCard, setComposerComputerUse, type ComposerComputerUse } from '../core/computerUse'
import { Button, InlineError, Sheet, Switch, useColors } from './kit'
import { Text } from './Text'
import { errorText } from './theme'

/** The switch controls the connected computer, not the next user message. */
export function ComputerUseControl({ client, visible, onEnabled }: {
  client: ApiClient | null; visible: boolean; onEnabled(enabled: boolean): void
}) {
  const colors = useColors()
  const [status, setStatus] = useState<ComposerComputerUse | null>(null)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [permission, setPermission] = useState(false)
  const permissionRequest = useRef<AbortController | null>(null)
  const readRequest = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const mutating = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => () => permissionRequest.current?.abort(), [client])
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    readRequest.current = controller
    const version = ++generation.current
    loadComposerComputerUse(client, controller.signal).then((value) => {
      if (!controller.signal.aborted && version === generation.current && !mutating.current) { setStatus(value); onEnabled(value.enabled); setPermission(value.enabled && needsComputerPermission(value)); setError('') }
    }).catch((e) => { if (!controller.signal.aborted && version === generation.current && !mutating.current) setError(errorText(e)) })
    return () => controller.abort()
  }, [client, visible, onEnabled])
  async function apply(enabled: boolean) {
    if (!client || !status || busy) return
    readRequest.current?.abort()
    generation.current++
    mutating.current = true
    setBusy(true)
    setError('')
    try {
      await setComposerComputerUse(client, enabled)
      generation.current++
      if (!mounted.current) return
      setStatus({ ...status, enabled })
      onEnabled(enabled)
      setConsent(false)
      setPermission(enabled && needsComputerPermission(status))
    } catch (e) { if (mounted.current) setError(errorText(e)) }
    finally { mutating.current = false; if (mounted.current) setBusy(false) }
  }
  return <>
    {visible && <View style={{ gap: 8, backgroundColor: colors.card, borderRadius: 14, padding: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ fontSize: 15, color: colors.ink }}>Computer Use</Text>
          <Text style={{ fontSize: 12.5, color: colors.ink3 }}>
            {status?.supported === false ? '这台电脑暂不支持' : '允许 Agent 操作这台电脑的屏幕和应用'}
          </Text>
        </View>
        <Switch label="Computer Use" value={status?.enabled ?? false} disabled={!status?.supported || busy}
          onValueChange={(enabled) => { if (enabled) setConsent(true); else void apply(false) }} />
      </View>
      <InlineError text={error} />
      {permission && <>
        <Text style={{ fontSize: 13, color: colors.ink2 }}>已开启，请在电脑完成屏幕录制和辅助功能授权。</Text>
        <Button title={busy ? '请在电脑完成授权…' : '在电脑上打开权限设置'} disabled={busy} onPress={() => {
          if (!client) return
          const controller = new AbortController()
          permissionRequest.current?.abort()
          permissionRequest.current = controller
          setBusy(true)
          void openComputerPermissionCard(client, controller.signal).then((value) => {
            if (controller.signal.aborted) return
            setStatus(value); onEnabled(value.enabled)
            setPermission(value.enabled && needsComputerPermission(value))
          }).catch((e) => { if (!controller.signal.aborted) setError(errorText(e)) })
            .finally(() => { if (!controller.signal.aborted) setBusy(false) })
        }} />
      </>}
    </View>}
    <Sheet visible={consent} onClose={() => { if (!busy) setConsent(false) }} title="开启 Computer Use">
      <Text style={{ fontSize: 15, lineHeight: 23, color: colors.ink }}>Agent 将能够查看这台电脑的屏幕内容，点击、输入、使用剪贴板和系统快捷键。授权覆盖所有应用，可能操作敏感内容或执行不可撤销的动作。</Text>
      <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>请留意执行过程；你可以停止任务，或随时关闭 Computer Use。macOS 还需要在电脑完成系统权限授权。</Text>
      <InlineError text={error} />
      <Button title={busy ? '正在开启…' : '我了解并开启'} disabled={busy} onPress={() => void apply(true)} />
      <Button title="取消" variant="secondary" disabled={busy} onPress={() => setConsent(false)} />
    </Sheet>
  </>
}
