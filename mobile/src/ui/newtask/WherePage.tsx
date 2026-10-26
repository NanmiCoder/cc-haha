import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import type { ApiClient } from '../../core/client'
import { type RecentProject, type RepositoryContext } from '../../core/newTask'
import { DirectoryBrowser } from '../DirectoryBrowser'
import { KeyboardViewport } from '../KeyboardViewport'
import { Text } from '../Text'
import {
  Button,
  Callout,
  Group,
  Icon,
  PageSheet,
  SearchField,
  Separator,
  Switch,
  TextButton,
  useColors,
} from '../kit'
import { useBottomInset } from '../decision/parts'
import { ChoiceRow } from './ChoiceRow'
import { cancelRestore, recentProjectRows, toggleWorktree, wherePageModel, type WhereDraft } from './whereModel'

export type WherePageProps = {
  visible: boolean
  /** 点“完成”、系统返回或下滑关闭：所有改动保留。 */
  onClose(): void
  /** 最近项目；传 `projectChoices(projects, path)`，当前目录不在其中时会排在最前。 */
  projects: RecentProject[]
  path: string
  /** 选了别的目录。换目录通常要同时重置分支和工作树，由调用方决定。 */
  onPath(path: string): void
  repo: RepositoryContext | null
  branch: string | null
  onBranch(value: string | null): void
  worktree: boolean
  onWorktree(value: boolean): void
  client: ApiClient | null
  /** 当前连接的电脑名，显示在“浏览电脑上的目录”行右侧；没有就不显示。 */
  hostName?: string
  busy?: boolean
  /** Git 状态读取失败时的“重新读取”。 */
  onRetry?(): void
}

const sectionTitle = { paddingTop: 14, paddingBottom: 6, paddingHorizontal: 4 } as const

/**
 * 位置页：一屏选完项目目录、分支和工作树。选择即时生效；“取消”把打开时的位置还原，
 * “完成”收起。“浏览电脑上的目录”在本页内推进到目录浏览，不再另开一层。
 */
export function WherePage(props: WherePageProps) {
  const { visible, onClose, projects, path, onPath, repo, branch, onBranch, worktree, onWorktree, client, hostName, busy, onRetry } = props
  const colors = useColors()
  const bottom = useBottomInset()
  const [view, setView] = useState<'main' | 'browse'>('main')
  const [query, setQuery] = useState('')
  // 每次打开记下当时的位置，“取消”用它还原；在渲染期间调整，避免 effect 里再 setState。
  const [opening, setOpening] = useState<WhereDraft>({ path, branch, worktree })
  const [wasVisible, setWasVisible] = useState(visible)
  if (visible !== wasVisible) {
    setWasVisible(visible)
    if (visible) {
      setOpening({ path, branch, worktree })
      setView('main')
      setQuery('')
    }
  }
  const rows = recentProjectRows(projects, path)
  const model = wherePageModel({ repo, path, branch, worktree, query })
  const cancel = () => {
    for (const step of cancelRestore(opening, { path, branch, worktree })) {
      if (step.type === 'path') onPath(step.value)
      else if (step.type === 'branch') onBranch(step.value)
      else onWorktree(step.value)
    }
    onClose()
  }
  const choosePath = (value: string) => {
    if (value !== path) onPath(value)
    setView('main')
  }

  if (view === 'browse')
    return (
      <PageSheet
        visible={visible}
        onClose={onClose}
        title="选择目录"
        left={<TextButton title="位置" onPress={() => setView('main')} />}
      >
        <DirectoryBrowser client={client} path={path} onSelect={choosePath} bottomInset={bottom} busy={busy} />
      </PageSheet>
    )

  return (
    <PageSheet visible={visible} onClose={onClose} title="位置" left={<TextButton title="取消" onPress={cancel} />}>
      <KeyboardViewport style={{ flex: 1 }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={hostName ? `浏览电脑上的目录，${hostName}` : '浏览电脑上的目录'}
            disabled={busy}
            onPress={() => setView('browse')}
            style={({ pressed }) => ({
              height: 48,
              borderRadius: 16,
              backgroundColor: colors.card,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 14,
              opacity: busy ? 0.45 : pressed ? 0.75 : 1,
            })}
          >
            <Icon name="folder" size={20} color={colors.ink2} strokeWidth={1.75} />
            <Text style={{ flex: 1, fontSize: 16, color: colors.ink }}>浏览电脑上的目录</Text>
            {hostName ? (
              <Text numberOfLines={1} style={{ maxWidth: 120, fontSize: 13, color: colors.ink3 }}>
                {hostName}
              </Text>
            ) : null}
            <Icon name="chevron-right" size={16} color={colors.chevron} strokeWidth={2.2} />
          </Pressable>

          <Text accessibilityRole="header" style={[sectionTitle, { fontSize: 13, fontWeight: '600', color: colors.ink2 }]}>
            最近项目
          </Text>
          {rows.length ? (
            <Group>
              {rows.map((row, index) => (
                <View key={row.key}>
                  {index ? <Separator inset={14} /> : null}
                  <ChoiceRow
                    title={row.name}
                    detail={row.detail}
                    detailMono
                    detailSize={12}
                    selected={row.selected}
                    disabled={busy}
                    accessibilityLabel={`选择项目 ${row.name}，${row.realPath}`}
                    onPress={() => choosePath(row.realPath)}
                  />
                </View>
              ))}
            </Group>
          ) : (
            <Text style={{ fontSize: 14, color: colors.ink3, paddingHorizontal: 4 }}>
              还没有最近项目，请浏览电脑上的目录。
            </Text>
          )}

          {model.gitHidden ? null : (
            <>
              <Text accessibilityRole="header" style={[sectionTitle, { fontSize: 13, fontWeight: '600', color: colors.ink2 }]}>
                分支
              </Text>
              {model.reason ? (
                <View style={{ gap: 8 }}>
                  <Callout>{model.reason}</Callout>
                  {onRetry && model.canRetry ? (
                    <Button title="重新读取 Git 状态" variant="plain" onPress={onRetry} disabled={busy || !path} />
                  ) : null}
                </View>
              ) : (
                <View style={{ gap: 8 }}>
                  <SearchField value={query} onChangeText={setQuery} placeholder="搜索分支" editable={!busy} />
                  <Group>
                    {model.rows.map((row) => (
                      <View key={row.name}>
                        <ChoiceRow
                          title={row.name}
                          titleMono
                          detail={row.detail}
                          trailingText={row.current ? '当前' : undefined}
                          selected={row.selected}
                          disabled={busy || row.disabled}
                          onPress={() => onBranch(row.name)}
                        />
                        <Separator inset={14} />
                      </View>
                    ))}
                    <ChoiceRow
                      title={model.follow.title}
                      titleWeight="400"
                      detail={model.follow.detail}
                      selected={model.follow.selected}
                      disabled={busy}
                      onPress={() => onBranch(null)}
                    />
                  </Group>
                  {model.noMatch ? <Text style={{ fontSize: 14, color: colors.ink3 }}>没有匹配的分支</Text> : null}
                  {model.warning ? <Callout>{model.warning}</Callout> : null}
                </View>
              )}

              {model.reason ? null : (
                <View
                  style={{
                    marginTop: 12,
                    backgroundColor: colors.card,
                    borderRadius: 16,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                  }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: 16, color: colors.ink }}>新开一个工作树</Text>
                    <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>{model.worktree.detail}</Text>
                  </View>
                  <Switch
                    label="新开一个工作树"
                    value={model.worktree.on}
                    disabled={busy || model.worktree.disabled}
                    onValueChange={(enabled) => {
                      const next = toggleWorktree(repo, branch, enabled)
                      onBranch(next.branch)
                      onWorktree(next.worktree)
                    }}
                  />
                </View>
              )}
            </>
          )}
        </ScrollView>
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 10,
            paddingBottom: bottom,
            borderTopWidth: 1,
            borderTopColor: colors.hair,
            backgroundColor: colors.bg,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="完成"
            onPress={onClose}
            style={({ pressed }) => ({
              height: 52,
              borderRadius: 16,
              backgroundColor: colors.btn,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: colors.btnInk }}>完成</Text>
          </Pressable>
        </View>
      </KeyboardViewport>
    </PageSheet>
  )
}
