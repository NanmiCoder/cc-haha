import { getMaxConcurrentSubagentsUncached } from '../../utils/settings/settings.js'

// 只统计普通 AgentTool 调用；不限时也计数，避免已打开的会话
// 动态启用或降低上限时遗漏仍在运行的子 agent。
let activeSubagents = 0

export function reserveSubagentSlot(): () => void {
  const limit = getMaxConcurrentSubagentsUncached()
  // 检查和递增之间没有 await，保证同进程嵌套或并行调用原子预留。
  // 不排队，避免嵌套子 agent 等待父 agent 的名额而死锁。
  if (limit != null && activeSubagents >= limit) {
    throw new Error(
      `Maximum concurrent subagents reached (${limit}). Wait for a running subagent to finish before spawning another. ` +
      'The user can change this limit in Settings > General.',
    )
  }
  activeSubagents += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeSubagents -= 1
  }
}
