import { View } from 'react-native'
import type { BrowserPreferredTarget } from '../core/browserUse'
import type { BrowserUse } from '../core/useBrowserUse'
import { Button, InlineError, Segmented, Sheet, Switch, useColors } from './kit'
import { Text } from './Text'
import { browserNote } from './compose/runLogic'

const TARGET_OPTIONS: { label: string; value: BrowserPreferredTarget }[] = [
  { label: '自动', value: 'auto' },
  { label: '工作区', value: 'workspace' },
  { label: 'Chrome', value: 'chrome' },
]

/** 开启「操作浏览器」前的确认单：启用电脑端内置浏览器与已连接 Chrome 的自动化能力。 */
export function BrowserUseConsent({ browser, inline = false }: { browser: BrowserUse; inline?: boolean }) {
  const colors = useColors()
  return (
    <Sheet inline={inline} visible={browser.consentOpen} onClose={browser.cancelConsent} title="开启操作浏览器">
      <Text style={{ fontSize: 15, lineHeight: 23, color: colors.ink }}>
        Agent 将能够操作电脑上的工作区内置浏览器或已连接的系统 Chrome，执行打开网页、阅读页面快照、点击与填写等操作。
      </Text>
      <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>
        遇到登录、二次验证、验证码或支付确认时，Agent 会自动暂停，请在电脑上手动接管后继续。无需授予系统屏幕录制或辅助功能权限。
      </Text>
      <InlineError text={browser.error} />
      <Button
        title={browser.busy ? '正在开启…' : '我了解并开启'}
        disabled={browser.busy}
        onPress={browser.confirmConsent}
      />
      <Button title="取消" variant="secondary" disabled={browser.busy} onPress={browser.cancelConsent} />
    </Sheet>
  )
}

/** 本条消息是否携带操作浏览器指令；全局开启确认与首选目标存放在电脑端。 */
export function BrowserUseRow({ browser, selected, onSelected, reason }: {
  browser: BrowserUse
  selected: boolean
  onSelected(value: boolean): void
  reason?: string
}) {
  const colors = useColors()
  return (
    <View>
      <View style={{ minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14 }}>
        <View style={{ flex: 1, gap: 2, paddingVertical: 8 }}>
          <Text style={{ fontSize: 16, color: colors.ink }}>操作浏览器</Text>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
            {browser.enabled && !reason
              ? '只对这条消息生效，发送后收起；浏览器全局开关仍保持开启。'
              : browserNote({ available: browser.available, reason })}
          </Text>
        </View>
        <Switch
          label="操作浏览器"
          value={selected}
          disabled={browser.available !== true || browser.busy || !!reason}
          onValueChange={(value) => {
            if (value) browser.selectForMessage(() => onSelected(true))
            else onSelected(false)
          }}
        />
      </View>
      {selected && browser.available === true ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
          <Segmented<BrowserPreferredTarget>
            label="浏览器目标"
            height={34}
            disabled={browser.busy}
            options={TARGET_OPTIONS}
            value={browser.preferredTarget}
            onChange={browser.setTarget}
          />
        </View>
      ) : null}
      {browser.error && !browser.consentOpen ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          <InlineError text={browser.error} />
        </View>
      ) : null}
    </View>
  )
}
