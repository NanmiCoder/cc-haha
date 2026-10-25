import React, { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { Text } from '../Text'
import {
  Button,
  Callout,
  FieldRow,
  Group,
  Icon,
  SectionHeader,
  Separator,
  Sheet,
  Switch,
  useColors,
} from '../kit'
import {
  branchChoices,
  displayPath,
  gitUnavailableReason,
  type RecentProject,
  type RepositoryContext,
} from '../../core/newTask'
import { ChoiceRow } from './ChoiceRow'

/** “在哪做”：项目、起始分支、是否新开工作树。在新任务页内切换，不是新路由。 */
export function WherePanel({
  projects,
  path,
  onPath,
  repo,
  branch,
  onBranch,
  worktree,
  onWorktree,
  busy,
  onBack,
  bottomInset,
}: {
  projects: RecentProject[]
  path: string
  onPath(path: string): void
  repo: RepositoryContext | null
  branch: string | null
  onBranch(branch: string | null): void
  worktree: boolean
  onWorktree(value: boolean): void
  busy?: boolean
  onBack(): void
  bottomInset: number
}) {
  const colors = useColors()
  const [other, setOther] = useState(false)
  const [custom, setCustom] = useState('')
  const reason = gitUnavailableReason(repo, path)
  const branches = branchChoices(repo)
  const failed =
    repo?.state === 'missing_workdir' || repo?.state === 'error'
  return (
    <>
      <View
        style={{
          height: 56,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 8,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="返回新任务"
          hitSlop={6}
          onPress={onBack}
          style={({ pressed }) => ({
            height: 44,
            paddingHorizontal: 6,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Icon name="chevron-left" size={20} color={colors.ink2} strokeWidth={2.2} />
          <Text style={{ fontSize: 16, color: colors.ink2 }}>新任务</Text>
        </Pressable>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 17,
            lineHeight: 22,
            fontWeight: '600',
            color: colors.ink,
          }}
        >
          在哪做
        </Text>
        <View style={{ width: 80 }} />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: bottomInset,
        }}
      >
        <SectionHeader title="项目" style={{ paddingTop: 4 }} />
        <Group>
          {projects.map((project) => (
            <React.Fragment key={project.realPath}>
              <ChoiceRow
                title={project.projectName}
                detail={displayPath(project.realPath)}
                detailMono
                detailSize={12.5}
                selected={project.realPath === path}
                disabled={busy}
                accessibilityLabel={`${project.projectName}，${project.realPath}`}
                onPress={() => {
                  if (project.realPath !== path) onPath(project.realPath)
                }}
              />
              <Separator inset={14} />
            </React.Fragment>
          ))}
          <ChoiceRow
            title="其他目录…"
            titleColor={colors.ink2}
            titleWeight="400"
            gap={10}
            leading={<Icon name="plus" size={18} color={colors.ink2} strokeWidth={2} />}
            disabled={busy}
            onPress={() => {
              setCustom(path)
              setOther(true)
            }}
          />
        </Group>

        <SectionHeader title="分支" />
        <Group>
          <ChoiceRow
            title="沿用当前工作树"
            titleWeight="400"
            detail={reason ? '没有可选的分支' : '保持电脑当前的提交，不切换分支'}
            selected={!reason && !branch}
            disabled={busy || Boolean(reason)}
            onPress={() => onBranch(null)}
          />
          {branches.map((item) => (
            <React.Fragment key={item.name}>
              <Separator inset={14} />
              <ChoiceRow
                title={item.name}
                titleMono
                titleColor={item.occupied ? colors.ink3 : undefined}
                detail={item.occupied ? '另一个工作树在用' : undefined}
                detailSize={12.5}
                trailingText={item.current ? '当前' : undefined}
                selected={branch === item.name}
                gap={10}
                disabled={busy}
                onPress={() => onBranch(item.name)}
              />
            </React.Fragment>
          ))}
        </Group>

        <View
          style={{
            marginTop: 12,
            backgroundColor: colors.card,
            borderRadius: 16,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 12,
            paddingHorizontal: 14,
          }}
        >
          <View style={{ flex: 1, gap: 2, opacity: reason ? 0.6 : 1 }}>
            <Text style={{ fontSize: 16, lineHeight: 21, color: colors.ink }}>
              新开一个工作树
            </Text>
            <Text
              style={{
                fontSize: 13,
                lineHeight: 18,
                color: failed ? colors.err : colors.ink3,
              }}
            >
              {reason ?? '不碰你电脑上正在改的代码'}
            </Text>
          </View>
          <Switch
            label="新开一个工作树"
            value={!reason && worktree}
            onValueChange={onWorktree}
            disabled={busy || Boolean(reason)}
          />
        </View>
        {repo?.state === 'ok' && repo.dirty ? (
          <Callout style={{ marginTop: 12 }}>
            项目里有没提交的改动，直接切分支可能被 Git 拦下。新开工作树更稳。
          </Callout>
        ) : null}
      </ScrollView>

      <Sheet visible={other} onClose={() => setOther(false)} title="其他目录">
        <Group>
          <FieldRow
            label="路径"
            accessibilityLabel="电脑上的目录路径"
            mono
            value={custom}
            onChangeText={setCustom}
            placeholder="例如 /Users/you/projects/app"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => {
              onPath(custom.trim())
              setOther(false)
            }}
          />
        </Group>
        <Button
          title="使用这个目录"
          size="lg"
          onPress={() => {
            onPath(custom.trim())
            setOther(false)
          }}
        />
        <Button
          title="使用电脑默认目录"
          variant="plain"
          onPress={() => {
            onPath('')
            setOther(false)
          }}
        />
      </Sheet>
    </>
  )
}
