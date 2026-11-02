import {
  displayPath,
  gitUnavailableReason,
  type RecentProject,
  type RepositoryContext,
} from '../../core/newTask'
import { branchForWorktreeMode, gitBranchOptions, gitLaunchWarning, worktreeBase } from './gitOptions'

export type WhereDraft = { path: string; branch: string | null; worktree: boolean }

/** 位置页的“最近项目”：名称 + 缩写路径，当前项打勾。 */
export function recentProjectRows(projects: RecentProject[], path: string) {
  return projects.map((project) => ({
    key: project.realPath,
    realPath: project.realPath,
    name: project.projectName,
    detail: displayPath(project.realPath),
    selected: project.realPath === path,
  }))
}

/**
 * 位置页“分支”区的全部派生状态：不可用原因、沿用/默认行、过滤后的分支行、提示、工作树开关。
 * 搜索同时匹配分支名和远端引用。
 */
export function wherePageModel({
  repo,
  path,
  branch,
  worktree,
  query,
}: {
  repo: RepositoryContext | null
  path: string
  branch: string | null
  worktree: boolean
  query: string
}) {
  const reason = gitUnavailableReason(repo, path)
  const ok = repo?.state === 'ok'
  const noCommits = ok && repo.headCommit === null
  const short = ok && repo.headCommit ? repo.headCommit.slice(0, 7) : null
  const base = worktreeBase(repo, null)
  const rows = gitBranchOptions(repo, query, worktree).map((option) => ({
    name: option.name,
    current: option.current,
    selected: branch === option.name,
    disabled: option.disabled,
    // 当前分支用“当前”标记，其余只在有话要说时才写副行（被占用、远端）。
    detail: option.current || option.detail === '本地分支' ? undefined : option.detail,
  }))
  return {
    reason,
    /** 非 Git 项目没有分支可选，不需要“重试”。 */
    canRetry: Boolean(reason) && repo?.state !== 'not_git_repo',
    /** 非 Git 目录整块隐藏分支与工作树；其余不可用原因（读取中、出错）显示说明。 */
    gitHidden: repo?.state === 'not_git_repo',
    follow: {
      title: worktree ? '使用默认起始分支' : '沿用电脑当前提交',
      detail: worktree
        ? `新工作树基于 ${base ?? '可用分支'}`
        : ['不切分支，停在电脑现在的位置', short].filter(Boolean).join(' · '),
      selected: !branch,
    },
    rows,
    noMatch: Boolean(query.trim()) && ok && rows.length === 0,
    warning: gitLaunchWarning(repo, branch, worktree),
    worktree: {
      on: worktree && !noCommits,
      disabled: noCommits,
      detail: noCommits
        ? '仓库还没有提交，暂时无法创建工作树'
        : worktree
          ? `发送时基于 ${worktreeBase(repo, branch) ?? '所选分支'} 创建独立目录`
          : '在独立目录工作，保留电脑当前的改动',
    },
  }
}

/** 切换工作树开关：回到当前目录模式时，丢掉只能在工作树里用的（被占用的）分支。 */
export function toggleWorktree(repo: RepositoryContext | null, branch: string | null, enabled: boolean) {
  return { worktree: enabled, branch: branchForWorktreeMode(repo, branch, enabled) }
}

/**
 * “取消”要还原的东西：按 路径 → 分支 → 工作树 的顺序，只还原变过的。
 * 路径放最前，因为换目录会让新任务页重置分支。
 */
export function cancelRestore(snapshot: WhereDraft, current: WhereDraft) {
  const steps: ({ type: 'path'; value: string } | { type: 'branch'; value: string | null } | { type: 'worktree'; value: boolean })[] = []
  if (snapshot.path !== current.path) steps.push({ type: 'path', value: snapshot.path })
  // 换回原目录后分支会被页面重置，所以路径变过时分支无论如何都要再设一次。
  if (snapshot.path !== current.path || snapshot.branch !== current.branch) steps.push({ type: 'branch', value: snapshot.branch })
  if (snapshot.worktree !== current.worktree || snapshot.path !== current.path) steps.push({ type: 'worktree', value: snapshot.worktree })
  return steps
}

/** 新任务顶部精简目标卡的内容：项目名 · 分支 · “新工作树”。 */
export function targetLine(target: { name: string; branch?: string; status?: string }, worktree: boolean) {
  return {
    name: target.name,
    branch: target.branch,
    status: target.branch ? undefined : target.status,
    note: worktree ? '新工作树' : undefined,
  }
}

/** 目标卡的无障碍朗读。 */
export function targetAccessibility(line: ReturnType<typeof targetLine>) {
  return `位置：${[line.name, line.branch ?? line.status, line.note].filter(Boolean).join('，')}`
}
