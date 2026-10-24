import type { PermissionMode } from '../core/types'
export const modes: {
  id: PermissionMode
  title: string
  description: string
}[] = [
  { id: 'default', title: '询问', description: '需要权限的操作先由你确认' },
  {
    id: 'acceptEdits',
    title: '接受编辑',
    description: '允许文件编辑，其他操作按规则确认',
  },
  { id: 'auto', title: '自动', description: '使用桌面端的自动审批规则' },
  { id: 'plan', title: '计划', description: '先讨论和规划，再批准执行' },
  {
    id: 'bypassPermissions',
    title: '全权限',
    description: '跳过工具审批，仅用于你信任的工作区',
  },
]
export const modeName = (id?: string) =>
  modes.find((mode) => mode.id === id)?.title ?? id ?? '询问'
