# /resume 命令适配方案

## 目标

在 Telegram（及飞书）适配器中新增 `/resume` 命令，让用户可以在 IM 端切换回已有会话，实现 CLI ↔ IM 无缝衔接。

## 现有基础设施

- `GET /api/sessions` — 已有，返回 `{ sessions: SessionListItem[], total }`，支持 `project`/`limit`/`offset` 参数
- `SessionStore` — 管理 chatId → sessionId 映射，`set()`/`get()`/`delete()`
- `WsBridge` — `resetSession(chatId)` 断旧连接 + `connectSession(chatId, sessionId)` 建新连接
- `AdapterHttpClient` — 需新增 `listSessions()` 方法

## 命令设计

| 用法 | 行为 |
|---|---|
| `/resume` | 列出最近 10 个会话，用户回复编号选择 |
| `/resume <session-id>` | 直接切换到指定 session（支持完整 UUID 或前缀匹配） |
| `/resume <关键词>` | 按标题模糊搜索，匹配到 1 个直接切换，多个则列出 |

## 实现步骤

### 1. AdapterHttpClient 新增 `listSessions()`

```ts
async listSessions(limit = 10, project?: string): Promise<SessionListItem[]> {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (project) params.set('project', project)
  const res = await fetch(`${this.httpBaseUrl}/api/sessions?${params}`)
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.statusText}`)
  const data = await res.json() as { sessions: SessionListItem[] }
  return data.sessions
}
```

类型定义（同 server 返回）：
```ts
export type SessionListItem = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  workDir: string
  workDirExists: boolean
}
```

### 2. telegram/index.ts 新增 `/resume` 命令

核心逻辑函数 `resumeSession(chatId, query?)`：

1. 如果有 query：
   - 尝试 UUID 前缀匹配 / 标题关键词搜索
   - 唯一匹配 → 直接切换
   - 多个匹配 → 列出供选择
   - 无匹配 → 提示
2. 如果无 query：
   - 调用 `httpClient.listSessions(10)`
   - 格式化为编号列表发送

切换流程（复用 `/new` 的模式）：
1. `clearTransientChatState(chatId)` — 清理流式状态
2. `bridge.resetSession(chatId)` — 断开旧 WS
3. `sessionStore.set(chatId, sessionId, workDir)` — 更新映射
4. `bridge.connectSession(chatId, sessionId)` — 建新 WS
5. `bridge.onServerMessage(chatId, handler)` — 注册消息处理
6. 等待 `bridge.waitForOpen(chatId)`

### 3. 待选会话交互状态

复用 `pendingProjectSelection` 的模式，新增 `pendingSessionSelection` Map。
当用户回复编号时，查找对应 session 并执行切换。

### 4. format.ts 更新

- `IM_HELP_LINES` 增加 `/resume [会话] — 恢复已有会话`
- 新增 `formatSessionList(sessions)` 格式化函数

### 5. 飞书适配器同步

`adapters/feishu/index.ts` 同步添加相同命令（结构与 TG 一致）。

## 交互示例

```
用户: /resume

Bot: 选择会话（回复编号）：

1. 本机安装了claude-haha… (4401c2a9)
   /Users/hcq · 44条消息 · 2分钟前

2. test (86f832df)
   /Users/hcq · 253条消息 · 1小时前

3. 默认会话开启在哪个目录下 (ef1d2333)
   /Users/hcq · 66条消息 · 1小时前

💡 也可直接 /resume <会话ID或关键词>

用户: 1

Bot: ✅ 已切换到会话：本机安装了claude-haha… (4401c2a9)
```

## 注意事项

- 切换会话前必须 `bridge.resetSession()` 彻底断旧连接，否则消息会路由到旧 session
- `workDir` 从 session 元数据获取，不需要用户再指定
- 列表中标注当前已连接的会话（带 ✦ 标记）
- session 列表按 modifiedAt 降序排列（API 默认行为）