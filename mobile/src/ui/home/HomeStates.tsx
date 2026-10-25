import { Fragment } from 'react'
import { View } from 'react-native'
import { Text } from '../Text'
import {
  BrandMark,
  Button,
  Card,
  Group,
  Icon,
  ListRow,
  Separator,
  Sheet,
  type,
  useColors,
} from '../kit'
import type { Project } from './homeModel'

/** 还没有电脑：EmptyState 的排版，图标位换成品牌标识（kit EmptyState 只收 IconName）。 */
export function ConnectEmpty({ onConnect }: { onConnect(): void }) {
  const colors = useColors()
  return (
    <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24, gap: 10 }}>
      <View style={{ marginBottom: 4 }}>
        <BrandMark size={52} />
      </View>
      <Text style={[type.headline, { color: colors.ink, textAlign: 'center' }]}>连接你的电脑</Text>
      <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink3, textAlign: 'center' }}>
        扫码回到你的工作现场，随时处理审批、派任务和查看结果。
      </Text>
      <Button
        title="扫码连接"
        icon="scan"
        onPress={onConnect}
        style={{ marginTop: 8, alignSelf: 'stretch' }}
      />
    </View>
  )
}

/** 连不上 / 授权失效：说明 + 换一台电脑 / 重新连接。 */
export function OfflineCard({
  unauthorized,
  onSwitch,
  onReconnect,
}: {
  unauthorized: boolean
  onSwitch(): void
  onReconnect(): void
}) {
  const colors = useColors()
  return (
    <Card style={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            backgroundColor: colors.fill,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={unauthorized ? 'shield' : 'wifi-off'} size={20} color={colors.ink2} />
        </View>
        <View accessibilityRole="alert" style={{ flex: 1, gap: 4 }}>
          <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '600', color: colors.ink }}>
            {unauthorized ? '这台电脑的授权已失效' : '连不上这台电脑'}
          </Text>
          <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>
            {/* 授权失效时服务端只给英文原因（Invalid H5 access token 等），不直接展示。 */}
            {unauthorized
              ? '电脑不再接受手机现在的凭据，需要重新扫码配对。配好后，旧的这条可以在「编辑」里移除；电脑上的会话都还在。'
              : '它可能睡着了，或者 cc-haha 没在运行。手机没法替电脑执行任务，也不能远程唤醒。'}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button title="换一台电脑" variant="secondary" onPress={onSwitch} style={{ flex: 1 }} />
        <Button
          title={unauthorized ? '重新配对' : '重新连接'}
          onPress={onReconnect}
          style={{ flex: 1 }}
        />
      </View>
    </Card>
  )
}

/** 底部“全部项目”打开的项目筛选；只在内存里记住选择。 */
export function ProjectSheet({
  visible,
  onClose,
  projects,
  selected,
  total,
  onSelect,
}: {
  visible: boolean
  onClose(): void
  projects: (Project & { count: number })[]
  selected: string | null
  total: number
  onSelect(key: string | null): void
}) {
  const colors = useColors()
  const pick = (key: string | null) => {
    onSelect(key)
    onClose()
  }
  const mark = (on: boolean) =>
    on ? <Icon name="check" size={18} color={colors.ink} strokeWidth={2.2} /> : null
  return (
    <Sheet visible={visible} onClose={onClose} title="按项目查看">
      <Group>
        <ListRow
          leading={<Icon name="list-filter" size={20} color={colors.ink2} />}
          title="全部项目"
          value={String(total)}
          trailing={mark(selected === null)}
          accessibilityLabel={`全部项目，${total} 个任务${selected === null ? '，已选择' : ''}`}
          onPress={() => pick(null)}
        />
        {projects.map((project) => (
          <Fragment key={project.key}>
            <Separator inset={46} />
            <ListRow
              leading={<Icon name="folder" size={20} color={colors.ink2} />}
              title={project.name}
              value={String(project.count)}
              trailing={mark(selected === project.key)}
              accessibilityLabel={`${project.name}，${project.count} 个任务${selected === project.key ? '，已选择' : ''}`}
              onPress={() => pick(project.key)}
            />
          </Fragment>
        ))}
      </Group>
    </Sheet>
  )
}
