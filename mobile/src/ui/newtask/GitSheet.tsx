import React, { useState } from 'react'
import { View } from 'react-native'
import { gitUnavailableReason, type RepositoryContext } from '../../core/newTask'
import { Text } from '../Text'
import { Button, Callout, Group, SearchField, SectionHeader, Separator, Sheet, Switch, useColors } from '../kit'
import { ChoiceRow } from './ChoiceRow'
import { branchForWorktreeMode, gitBranchOptions, gitLaunchWarning, worktreeBase } from './gitOptions'

export function GitSheet({ visible, onClose, path, repo, branch, onBranch, worktree, onWorktree, busy, onRetry }: {
  visible: boolean
  onClose(): void
  path: string
  repo: RepositoryContext | null
  branch: string | null
  onBranch(value: string | null): void
  worktree: boolean
  onWorktree(value: boolean): void
  busy?: boolean
  onRetry?(): void
}) {
  const colors = useColors()
  const [query, setQuery] = useState('')
  const close = () => {
    setQuery('')
    onClose()
  }
  const reason = gitUnavailableReason(repo, path)
  const rows = gitBranchOptions(repo, query, worktree)
  const warning = gitLaunchWarning(repo, branch, worktree)
  const noCommits = repo?.state === 'ok' && repo.headCommit === null
  const current = repo?.currentBranch || (repo?.headCommit ? `HEAD ${repo.headCommit.slice(0, 7)}` : '当前提交')
  const base = worktreeBase(repo, branch)
  return (
    <Sheet visible={visible} onClose={close} title="分支与工作树">
      {reason ? (
        <>
          <Callout>{reason}</Callout>
          {onRetry && repo?.state !== 'not_git_repo' ? <Button title="重新读取 Git 状态" variant="plain" onPress={onRetry} disabled={busy || !path} /> : null}
        </>
      ) : (
        <>
          <View style={{ backgroundColor: colors.card, borderRadius: 16, flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ fontSize: 16, color: colors.ink }}>新开一个工作树</Text>
              <Text style={{ fontSize: 13, color: colors.ink3 }}>{noCommits ? '仓库还没有提交，暂时无法创建工作树' : worktree ? `发送时基于 ${base ?? '所选分支'} 创建独立目录` : '在独立目录工作，保留电脑当前的改动'}</Text>
            </View>
            <Switch label="新开一个工作树" value={worktree && !noCommits} disabled={busy || noCommits} onValueChange={enabled => {
              onBranch(branchForWorktreeMode(repo, branch, enabled))
              onWorktree(enabled)
            }} />
          </View>
          <SectionHeader title="起始分支" />
          <SearchField value={query} onChangeText={setQuery} placeholder="搜索分支" editable={!busy} />
          <Group>
            <ChoiceRow title={worktree ? '使用默认起始分支' : '沿用电脑当前提交'} detail={worktree ? `新工作树基于 ${worktreeBase(repo, null) ?? '可用分支'}` : `${current}，不切换分支`} selected={!branch} disabled={busy} onPress={() => onBranch(null)} />
            {rows.map(item => <React.Fragment key={item.name}>
              <Separator inset={14} />
              <ChoiceRow title={item.name} titleMono detail={item.detail} selected={branch === item.name} disabled={busy || item.disabled} onPress={() => onBranch(item.name)} />
            </React.Fragment>)}
          </Group>
          {!rows.length && query ? <Text style={{ color: colors.ink3, fontSize: 14 }}>没有匹配的分支</Text> : null}
          {warning ? <Callout>{warning}</Callout> : null}
          <Button title="完成" size="lg" onPress={close} disabled={busy} />
        </>
      )}
    </Sheet>
  )
}
