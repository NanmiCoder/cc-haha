# cc-haha 自定义优化（0.6.6 基座重实现）

> 本文件以 v0.6.6（2f8d819d，本仓库）为基座，重实现旧基座（v0.5.3，`/home/zeaxion/myproject/CC-HAHA-Scode` 分支 `perf/transcript-chunked-recovery`）上已验证的优化项。
> **2026-09-26 起基座更新**：上游 main（`068b3ebd`，2026-09-25，含 pending 问题超时自动回答、聊天外观偏好、CORS 门控重做等 20 个 commit）已融入 `custom-066`（merge commit `4e25e022` + 修复合并 `005684ea`），全部 patch 重基到 `068b3ebd`（见下方 Patch 清单说明）。
> 需求权威源：`CC-HAHA-Scode/cc-haha自定义优化.md`（下文「源章节」均指该文件）。
> 状态图例：⬜待实施 · 🕓待实施/规划 · 🔍调研 · ✅已实施
> 当前为**骨架版**：仅保留章节结构与标题，实施时逐节填充（问题背景 / 0.6.6 现状核对 / 实施方案 / 验证）。
> **备注：旧优化文档的内容、逻辑、实现原理仅作为参考，具体在新代码（0.6.6 基座）上落地需量身定制**——组件名、挂载点、store/API、i18n key 等一律以 0.6.6 实际代码现状为准，逐章先核对再实施，不做整块照搬。

## 📇 分类目录（按优化项归类）

| 主题 | 章节 | 源章节 | 状态 |
|------|------|--------|------|
| 功能特性 | 一 H5 访问「需要访问令牌」开关 + 免令牌豁免 | 旧§二 | ✅ |
| 功能特性 | 二 会话导出（md/html/txt + 压缩边界范围） | 旧§三 | ✅ |
| 工具调用/协议 | 三 会话刷新按钮（卡住软刷新规避） | 旧§八 | ✅ |
| 功能特性 | 四 实时解码速度（TPS）指示器 + 手机端两行 | 旧§九/§十六 | ✅ |
| 功能特性 | 五 文件下载桥接 | 旧§十二 | ✅ |
| 功能特性 | 六 设置-关于-更新：禁止更新开关 | 旧§十三 | ✅ |
| 计费/上下文 | 七 上下文缓存与计费显示（cache 命中率修正） | 旧§十四 | ✅ |
| 功能特性 | 八 思考模式二级开关（think 是否回传后端） | 旧§二十五 | ✅ |
| 功能特性 | 九 H5 设置页与桌面端全 tab 对齐（放开浏览器「两 pill」围栏） | —（新增） | ✅ |
| 工程/开发 | 十 本地开发模式注意事项（sidecar 开发模式跑通记录） | — | ✅ |
| 移动端/H5 | 十一 H5 悬浮快捷入口（任务列表 / 终端 / 文件浏览 / 审查） | 旧§5.2 FAB（参考） | ✅ |
| 工程/质量 | 十二 src/server 既有 22 条测试失败清零 | —（新增） | ✅ |
| 上下文/压缩 | 十三 pi-vcc 算法压缩移植（transcript-preserving，无 LLM 调用）+ 双后端热切换 + vcc_recall 工具 | 新增（参考 @sting8k/pi-vcc 0.8.0） | ✅ |
| 移动端/H5 | 十四 H5/移动端支持打开插件市场（技能·连接器） | —（新增） | ✅ |
| 移动端/H5 | 十五 H5/移动端支持打开计划任务（定时任务）页 | —（新增） | ✅ |
| 连接器/平台 | 十六 连接器目录 Linux 平台支持（x64/arm64，服务端 H5 场景生效） | —（新增） | ✅ |
| 移动端/H5 | 十七 H5/移动端 技能市场页 header 布局适配（副标题不再折多行） | —（新增） | ✅ |
| 平台/功能 | 十八 Computer Use 解锁 Linux（X11）平台 | —（新增） | ✅ |
| 上下文/压缩 | 十九 bc 压缩后 context usage 不收敛（显示总量改 usage 锚口径） | —（新增） | ✅ |
| 性能/传输 | 二十 H5 远端 API 响应 gzip 压缩传输（非本机默认开启，省 68% 带宽） | —（新增） | ✅ |
| 功能特性/显示 | 二十一 思考计时与工具计时综合优化（思考 token+耗时 badge、收纳栏总计时+token、轮次用量、**子代理耗时+子代理收纳栏总耗时+后台任务耗时**） | —（新增） | ✅ |
| 性能/历史 | 二十二 历史记录膨胀（`toolUseResult.originalFile`）致大体积会话打不开 | —（新增） | 🔍 主要实施（A+B+E+G+H ✅；C 证伪；D `projectContext` 候选；F 待授权） |
| 性能/显示 | 二十三 子代理内容实时反馈（opencode 式，替代当前间隔刷新） | —（新增） | ⬜ 待办（仅登记，不推进） |
| 上下文/压缩 | 二十四 上下文压缩阈值按窗口分档（软触发百分比 + 硬触发绝对下限） | —（新增） | ✅ 已实施 |
| 功能特性/显示 | 二十五 轮次用量 + think 用量 + 收纳栏 综合优化 | —（新增） | ➡ 已并入第二十一章（子优化②） |

## 📦 联动 Patches

> 各优化项的实施 diff 以 patch 文件形式统一存放到本 `modify/` 目录（后期全部归档于此），与上文章节联动：每完成一项，patch 入库并在此登记；升级/重打基座时按本表逐个 `git apply` 重放。
>
> **2026-09-26 重基**：全部 patch 重基到上游 `068b3ebd`（origin/main 2026-09-25，含 20 个新 commit：CORS 门控重做/切 tab 保视图/历史不全保聊天/内存保存竞态两修/pending 问题超时自动回答/聊天外观偏好/OAuth 2.1.281 对齐/agent-teams/Kimi K3 图片透传/定时任务持久化串行化）。应用方式=按下表从上到下逐章 `git apply --allow-empty`。空 patch（h5-settings-whitelist、h5-mobile-market）内容已被后续章节的共享文件覆盖，apply 后无变化。
>
> **当前链规模（2026-09-27）**：共 **41 patch**（39 实 + 2 空）。最新一位：`subagent-background-task-durations`（二十一 子优化④：子代理耗时 + 子代理收纳栏总耗时 + 后台任务耗时，链位 41）。前一位：`tps-content-accounting`（四 子优化：TPS 计量改为按内容度量，链位 40）。再前：`tps-real-token-accounting`（四 子优化：TPS 采样改真实 token 口径，链位 37）、`compact-dead-import-cleanup`（策略门禁 dead-imports 清理，链位 38）、`session-speed-and-usage-pairing`（四 子优化：面板生成速度分子分母配对 + transcript usage 去重丢 output 修复，链位 39）。新增：`turn-usage`（二十一 子优化②）、`thinking-badge-order-and-duration`（二十一 子优化①，前端 + API 层）、`baseline-typecheck-fixes`、`autocompact-window-tiers`、`history-transport-bounds`、`file-history-dedup`、`gzip-transport`、`history-first-paint-bound`（前端）、`storage-original-file-bound`（二十二 F 存量瘦身，含新测试文件）、`computer-use-platform-components`（十八 平台化组件选择）、`computer-use-python-path-fallback`（十八 解释器路径回退）、`tps-centered-second-line`（四 费用/TPS 第二行居中）、`h5-mobile-run-records`（二十五 H5 子代理运行记录，链位 36）。
>
> **全链验证（2026-09-27 收尾，决定性）**：在干净基线 `068b3ebd` 的**临时 worktree** 上按上表顺序 `git apply --allow-empty` 全部 **35 个 patch → 失败 0 个**；应用后终态与工作树在**本轮 4 个新 patch 涉及的全部 14 个文件**上**逐字节一致**，全树剩余差值仅为下节「已知非章 delta」。此为权威口径（早前「HEAD 上暂存往返」是非全链验证，已由本次全链取代）。**2026-09-27 追加第 36 位（`h5-mobile-run-records`）与 `tps-indicator`/`turn-usage` 重生成后复验：36 链同样失败 0，第 7 章 8 文件 + `chatStore.test.ts` + `AppShell.{tsx,test.tsx}` 逐字节等于工作树。** **2026-09-27 二次追加第 37/38 位（`tps-real-token-accounting`、`compact-dead-import-cleanup`）后复验：干净重跑 38 链失败 0，本轮 23 个文件（20 TPS + 3 dead-import）**逐字节等于工作树**。** **2026-09-27 三次追加第 39 位（`session-speed-and-usage-pairing`）后复验：干净重跑 39 链失败 0，本轮 13 个文件**逐字节等于工作树**。**
>
> ⚠️ **必须按表顺序应用，不是「任意顺序」**：patch 之间存在**同文件重叠**——`turn-usage` 与 `thinking-tool-timing`（均改 `chatStore.ts`/`types/chat.ts`）、`tps-indicator`（`chatStore.ts`）、`h5-require-token`（`i18n/locales/*`）共享文件。重叠 patch 的 hunk 上下文取自各自上游状态，乱序应用可能失败。早期「各 patch 文件互不重叠、可任意顺序」的说明仅对当时较小的链成立，**现已作废**。
>
> ⚠️ **生效方式不同**：服务端 4 个 patch 由 bun 直跑源码，重启 sidecar 即生效；`history-first-paint-bound` 是**前端**（`desktop/src/api/sessions.ts`），**必须 `vite build` 重建 dist** 才生效（H5 与桌面共用 `desktop/dist`）。
### 命名与存放约定
- 存放：`modify/patches/`（patch 文件统一子目录）
- 命名：**按优化项语义归类，不用数字编号**——`<优化项短名>.patch`，短名直接取自该优化项的英文关键词（如 `h5-require-token.patch`、`session-export.patch`），一眼可读、与章节标题对应
- 生成（2026-09-26 起重基法）：`git diff <上一章链 commit> <本章链 commit> > patch`，链起点=`068b3ebd`，每章 patch 相对上一章终态
- 每章完成后在此表登记状态；冲突时以「该章节最新实施记录」为准重新出 patch

### Patch 清单

| # | Patch 文件 | 对应优化项（章节） | 状态 |
|---|---|---|---|
| 1 | `patches/h5-require-token.patch` | 一 H5 令牌开关 + 免令牌豁免 | ✅ |
| 2 | `patches/h5-auto-mode-optin.patch` | 一 H5 选「自动模式」400 修复（1.1） | ✅ |
| 3 | `patches/session-export.patch` | 二 会话导出 | ✅ |
| 4 | `patches/h5-settings-parity.patch` | 九 H5 设置全 tab 对齐 | ✅ |
| 5 | `patches/h5-terminal-bridge.patch` | 一 H5 终端桥接（1.2） | ✅ |
| 6 | `patches/session-refresh.patch` | 三 会话刷新按钮 | ✅ |
| 7 | `patches/tps-indicator.patch` | 四 TPS 指示器 + 两行 + 子代理汇聚 + 展示格式/4 位封顶（#90） | ✅ |
| 8 | `patches/file-download.patch` | 五 文件下载桥接（含右键/菜单下载 + H5 内置浏览器提示） | ✅ |
| 9 | `patches/disable-updates.patch` | 六 禁止更新开关 | ✅ |
| 10 | `patches/cache-billing.patch` | 七 上下文缓存与计费显示 | ✅ |
| 11 | `patches/thinking-switch.patch` | 八 思考模式二级开关 | ✅ |
| 12 | `patches/h5-settings-whitelist.patch` | 九 H5 设置项 400/403 修复（9.x，remoteBrowser 白名单）— 重基后空 patch（内容被前序共享文件覆盖） | ✅ |
| 13 | `patches/server-test-baseline-zeroing.patch` | 十二 src/server 既有 22 条测试失败清零 | ✅ |
| 14 | `patches/h5-mobile-quick-actions.patch` | 十一 H5 悬浮快捷入口（任务/终端/文件/审查） | ✅ |
| 15 | `patches/vcc-compactor.patch` | 十三 pi-vcc 算法压缩移植 + 双后端热切换 + vcc_recall | ✅ |
| 16 | `patches/h5-mobile-market.patch` | 十四 H5/移动端支持打开插件市场 — 重基后空 patch（同上） | ✅ |
| 17 | `patches/h5-mobile-scheduled.patch` | 十五 H5/移动端支持打开计划任务（定时任务）页 | ✅ |
| 18 | `patches/connector-linux-platform.patch` | 十六 连接器目录 Linux 平台支持（x64/arm64） | ✅ |
| 19 | `patches/h5-mobile-market-layout.patch` | 十七 H5/移动端 技能市场页 header 布局适配 | ✅ |
| 20 | `patches/computer-use-linux-x11.patch` | 十八 Computer Use 解锁 Linux（X11） | ✅ |
| 21 | `patches/context-usage-anchor.patch` | 十九 bc 压缩后 context usage 不收敛（显示总量 usage 锚口径 + projector metadata 上限加固） | ✅ |
| 22 | `patches/h5-gzip-transport.patch` | 二十 H5 远端 API 响应 gzip 压缩传输 | ✅ |
| 23 | `patches/thinking-tool-timing.patch` | 二十一 思考计时与工具计时综合优化（思考 badge+收纳栏总计时+token） | ✅ |
| 24 | `patches/autocompact-window-tiers.patch` | 二十四 上下文压缩阈值按窗口分档（软触发百分比 + 硬触发绝对下限） | ✅ 已实施 |
| 25 | `patches/history-transport-bounds.patch` | 二十二 历史传输裁剪（`toolUseResult` 有界投影）+ 读取预算收紧 | 🔍 部分（A+H） |
| 26 | `patches/file-history-dedup.patch` | 二十二 E file-history `-completed-*` 重复消除（变动才建） | ✅ 已实施 |
| 27 | `patches/gzip-transport.patch` | 二十二 G gzip 传输改造：同步→异步（移出事件循环）+ 会话大小门控（<10MB 不压缩） | ✅ 已实施 |
| 28 | `patches/history-first-paint-bound.patch` | 二十二 B 首屏翻页上限（提前返回并保留 `nextCursor`，打通既有「加载更早」） | ✅ 已实施 |
| 29 | `patches/baseline-typecheck-fixes.patch` | 基线真缺陷修复：`index.ts` TS2502（参数遮蔽致类型自引用）+ vendor 重复导入 TS2300 | ✅ 已实施 |
| 30 | `patches/thinking-badge-order-and-duration.patch` | 二十一 子优化①：收纳栏「token 在前、耗时在后」+ `+` 间隔收紧 + 零耗时按未测处理 | ✅ 已实施 |
| 31 | `patches/turn-usage.patch` | 二十一 子优化②：轮次用量（每轮总消耗 token，口径=真实 `output_tokens`，`usageKey` 去重） | ✅ 已实施 |
| 32 | `patches/tps-centered-second-line.patch` | 四 费用/TPS **保持上下两行**，TPS 由右对齐改**第二行居中**（桌面 `ActiveSession.tsx` + H5 `AppShell.tsx`） | ✅ 已实施 |
| 33 | `patches/storage-original-file-bound.patch` | 二十二 F **存量瘦身**：写入侧对 `toolUseResult.originalFile` 做 16KB 有界裁剪（+ `originalFileTruncated/Bytes` 标记，含新测试文件） | ✅ 已实施 |
| 34 | `patches/computer-use-platform-components.patch` | 十八 平台化组件选择：`pythonRuntimeFor()` 显式平台表（macOS/未知平台无 Python 组件），修复「二元三目」把 win 依赖清单发给 mac | ✅ 已实施 |
| 35 | `patches/computer-use-python-path-fallback.patch` | 十八 无原生文件选择器时**回退填入已探测解释器路径**（+ 5 语言 i18n 键 + 测试） | ✅ 已实施 |
| 36 | `patches/h5-mobile-run-records.patch` | 二十五 **H5 打不开子代理运行记录**：移动端 tab 守卫白名单补 `subagent`/`team-member`（+ 2 测试） | ✅ 已实施 |
| 37 | `patches/tps-real-token-accounting.patch` | 四 子优化：**TPS 采样改真实 token 口径**——自适应三层源（ids/chunk/char）+ 真实 `output_tokens` 对账校准 + 按模型分桶持久化 + 引擎 `return_token_ids` 旁路（20 文件 1717 行） | ✅ 已实施 |
| 38 | `patches/compact-dead-import-cleanup.patch` | 策略门禁 `check:policy` 的 **dead-imports 清零**（十三章 vcc 移植遗留的 3 处未引用导入；该规则口径是「删」而非白名单） | ✅ 已实施 |
| 39 | `patches/session-speed-and-usage-pairing.patch` | 四 子优化：**面板「生成速度」分子分母配对**（decode 只除「同批被测到 span 的 token」，非流式回退不再抬高速度）+ **transcript usage 去重改保留末行**（首行 `output_tokens: 0` 曾致 output/cache_read 全丢，13 文件 1183 行） | ✅ 已实施 |
| 40 | `patches/tps-content-accounting.patch` | 四 子优化：**TPS 计量改为按内容度量**（CJK/latin 两系数最小二乘 + `ids` 独占；废弃按帧计数的 chunk 层——6 并发子代理下它把读数抬到真实值 2~3 倍的根因） | ✅ 已实施 |
| 41 | `patches/subagent-background-task-durations.patch` | 二十一 子优化④：**子代理耗时 + 子代理收纳栏总耗时 + 后台任务耗时**（上报值优先→时间戳回退；`agentGroupDurationMs` 另立，因全 Agent 组不进 `ActivityGroup`；新建 `ToolCallGroup.test`） | ✅ 已实施 |

> **已知非章 delta（有意不入 patch，链终态与工作树的结构性差值）**：`#83` 测试修复族（`src/testUtils/modelEnv.ts` 及 11 个 `*.test.ts`：`print.sessionMessage`/`constants/system`/`coreSchemas.modelInfo`/`api/client`/`skills/bundled/computerUse`/`builtInAgentOverrides`/`effort.agent`/`model/{agent,fable,opus55,opus5}`/`__tests__/thinking`/`permissions/PermissionUpdate`）、`MessageList.test.tsx`（flaky 超时放宽，见附录）、`TerminalSettings.tsx`、`lib/providerModels.ts`、`services/api/claude.ts`（bound-thinking WIP）、`desktop/package.json`（本轮新增 `build:renderer`/`typecheck` 两条 **dev 脚本**，electron-builder 打包时会剥离 `scripts`，故不影响产物）、`bun.lock`。

### 移植通用注意事项- stale `.js` 孪生：改 `src/*.ts` 走 sidecar 打包路径时，须核对被改文件同名 `.js` 是否存在且同步（旧树 `.js` 优先加载坑）。
- 0.6.6 已有对应能力需**融合**而非整块覆盖（如 H5 安全配对、缓存 token 显示、rewind 等），各章落地前先核对现状。
- 桌面 UI 项 i18n 需覆盖 5 语言（en/zh/jp/kr/zh-TW）。
- 验证：`bunx tsc --noEmit` + 相关 vitest + UI 人工验证。

---

## 一、H5 访问「需要访问令牌」开关 + loopback/私网/ULA 免令牌（源§二，✅ 2026-09-24）

### 需求背景

旧§二在 0.5.3 上实现：H5「需要访问令牌」开关 + loopback/RFC1918/ULA 私网来源免令牌（2026-08-11 补充私网豁免）。本次在 0.6.6 重实现，并与用户确认两点最终语义：
- **默认不启用 H5 令牌**（`requireToken: false`）= 0.0.0.0/0 全免 token；
- 开关开启（`true`）时：loopback + RFC1918（10/8、172.16/12、192.168/16、169.254）+ IPv6 ULA（fc00::/7）来源**按 socket 源地址**（`server.requestIP()`）免 token，公网来源需 Bearer token；
- 开关在桌面端设置 → H5 访问 tab 内联动（即时生效，非 draft/save 模式）。

### 0.6.6 现状核对

- 0.6.6 的 `H5AccessSettings`（`src/server/services/h5AccessService.ts`）**无 requireToken 字段**，`normalizeStoredSettings` 静默丢弃；token 是 H5 能力路径的唯一门槛。
- 策略单点 `shouldRequireH5Token`（`src/server/h5AccessPolicy.ts`）：h5Enabled && 能力路径 && `classify==='h5-browser'` → 要 token；loopback 请求被 `local-trusted` 分类直接豁免，**私网来源不豁免**（外部 IP 浏览器一律 h5-browser）。
- 桌面端 `desktopRuntime.ts` 的 `requiresH5AuthForServerUrl` 只豁免 loopback → LAN IP 打开 H5 即使服务端免 token 也会在前端弹 token 输入。

### 实施方案

服务端（4 文件 + 2 测试）：
- `h5AccessService.ts`：`H5AccessSettings` 加 `requireToken: boolean`（默认 false）；`DEFAULT_STORED_SETTINGS.requireToken = false`；`normalizeStoredSettings` 用 `value.requireToken === true` 解析（旧配置升级后默认关闭）；`toPublicSettings`/`updateSettings` 透传。
- `h5AccessPolicy.ts`：新增 `isPrivateIPv4Source`（RFC1918+169.254）与导出 `isTrustedLocalSourceHost(host)`（剥 bracket/`::ffff:` 前缀 → loopback → IPv6 走 ULA 正则 `/^f[cd][0-7][0-9a-f]:/` → 否则私网 IPv4）；`shouldRequireH5Token` 加必填 `requireToken`：`!requireToken → false`（全免），否则 `!isTrustedLocalSourceHost(clientAddress)`。
- `index.ts`：调用点传 `requireToken: h5Settings.requireToken`；`api/h5-access.ts`：PUT body 透传 `requireToken`。
- 测试：`h5-access-policy.test.ts` 全部调用加 `requireToken` 参数，loopback/私网源断言翻转为 false，新增私网豁免/公网需 token/requireToken=false 全开/`isTrustedLocalSourceHost` 边界（fd12 非 ULA、fd9a::7f 非 ULA、172.32 非私网等）用例。

桌面端（7 文件 + i18n 5 语言 + 测试）：
- `types/settings.ts`、`stores/settingsStore.ts`（DEFAULT false + normalize `=== true`）、`api/h5Access.ts` 加字段。
- `pages/settings/H5AccessSettings.tsx`：enabled 行下方新增 checkbox，onChange 直接 `updateH5AccessSettings({ requireToken })` 即时生效。
- `lib/desktopRuntime.ts`：`initializeBrowserServerUrl` 加 **tokenless 快速路径**——health 通过后先 `ensureBrowserApiAccessibleWithoutH5(url)` 探 `/api/status`（仅 401 才抛 `H5ConnectionRequiredError('missing-token')`），成功即 `setAuthToken(null)` 直连；仅 missing-token 时落入原 token 输入流程。
- i18n 5 语言各加 `h5AccessRequireToken`/`h5AccessRequireTokenHint` 2 key；`generalSettings.test.tsx`/`settingsStore.test.ts` fixture 补 `requireToken: false`，另 4 处 `updateH5AccessSettings` 精确匹配断言**不含**该字段（H5 save 处理器只发 3 字段，开关独立）。

### 验证

- 服务端 `bun test`：h5-access-policy 31/31 + h5-access-service 28/28 pass（含新增私网/ULA 边界用例）。
- 桌面端 vitest：`generalSettings.test.tsx` 131 pass、`settingsStore.test.ts` 64 pass、`desktopRuntime.test.ts` 30/30（新增 LAN 免 token 直连用例）；`tsc -b` exit 0。
- dev 7788 live（LAN 视角，`http://192.168.10.43:7788`）：
  - `requireToken=false`：LAN/loopback/模拟公网（XFF）无 token `/api/status`、`/api/sessions` 均 200；带 token 200。
  - `requireToken=true`（重启后）：LAN 无 token 200（私网豁免）、loopback 无 token 200、带 token 200。
  - 控制面（带 desktop process token `CC_HAHA_LOCAL_ACCESS_TOKEN`）：`PUT /api/h5-access {"requireToken": true/false}` 200 且 `settings.json` 落盘正确——UI 开关落地链路打通。
- 真实设备回归：192.168.10.140 手机此前弹「需要 token」，根因是 **dist bundle 过期**（旧 `requiresH5AuthForServerUrl` 逻辑），重 build + 重启后免 token 直连成功。
- Patch：`modify/patches/h5-require-token.patch`（基线 2f8d819d，v0.6.6）。

### 1.1 附带修复：H5 选「自动模式」持续 400（✅ 2026-09-24）

**问题**：H5（手机浏览器）会话中权限审批选择「自动模式」时，点确认后 toast 一直报错（400）。

**根因**：选自动模式会触发两步，第一步 `acceptAutoModeOptIn()`（`desktop/src/stores/settingsStore.ts:389`）走 `PUT /api/settings/user { skipAutoPermissionPrompt: true }`（`desktop/src/api/settings.ts:28`）。H5 请求被 `classifyH5Request` 判为 `h5-browser` → `router.ts:560` 置 `remoteBrowser: true` → `router.ts:67` 调 `validateRemoteSettingsPatch`（`src/server/remoteBrowserPolicy.ts:37`）。而 `WRITE_SETTINGS` 白名单（`remoteBrowserPolicy.ts:5`）只有 `language/chatSendBehavior/alwaysThinkingEnabled/workflowKeywordTriggerEnabled/outputStyle` 5 个字段，**不含 `skipAutoPermissionPrompt`**（该字段在 READ_SETTINGS 可读不可写）→ 400 `Unsupported General setting`。桌面端（local-trusted）不走此校验，故仅 H5 报错。

**修复**：`src/server/remoteBrowserPolicy.ts` `WRITE_SETTINGS` 加入 `skipAutoPermissionPrompt`（boolean，走既有末行 `typeof value === 'boolean'` 校验）。只翻一个持久化 userSettings 布尔位，风险等级与其它白名单布尔字段一致。

**验证**：
- 单测：`src/server/router.remoteBrowser.test.ts` 合法 patch 用例加入 `skipAutoPermissionPrompt: true`，并补「单独 PUT 该字段 200 + 落盘」「字符串值 `'true'` 仍 400」断言；8/8 pass。
- dev 7788 live（LAN 视角，h5-browser 分类）：`PUT /api/settings/user {skipAutoPermissionPrompt:true}` 修复前 400 → 修复后 200，且 `GET` 读回 `{"skipAutoPermissionPrompt":true}` 落盘正确。
- Patch：`modify/patches/h5-auto-mode-optin.patch`（基线 2f8d819d，v0.6.6，2 文件 37 行，`git apply --check` 干净应用）。

### 1.2 H5 终端桥接：让 H5 浏览器端也能用终端（✅ 2026-09-24）

**需求**：终端能力原本桌面独占——`browserHost.capabilities.terminal=false`（`desktop/src/lib/desktopHost/browserHost.ts:19`），`terminalApi.isAvailable()`（`desktop/src/api/terminal.ts:33`）在浏览器下为 false，`TerminalSettings.tsx` 只显示「unavailable」空态。目标是让通过 H5 访问的手机浏览器也能起一个真实 PTY 终端，默认工作目录跟随当前会话 workDir，功能完整对齐（含 shell 选择 + bash 路径设置）。

**现状核对（桌面如何走）**：桌面终端经 electronHost IPC（`terminalSpawn/Write/Resize/Kill` + 订阅 `terminalOutput/terminalExit`，`desktop/src/lib/desktopHost/electronHost.ts:179-189`，IPC 通道 `electron/ipc/channels.ts:54-55,101`）。服务端逻辑在 `electron/services/terminal.ts`：shell 解析 `resolveShell()`（`terminal.ts:613-622`）= `resolveDesktopTerminalShell`（仅 win32 生效，`terminal.ts:216-245`）?? `defaultShell`（`terminal.ts:201-214`，非 win32=`env.SHELL` 或 zsh/bash）；`terminalEnvironment`+`loginShellEnvironment`（`-l -c 'env -0'`）+`ensureUtf8Locale` 构造 env；min cols/rows=20/8；cwd 解析 `resolveTerminalCwd`。**前端 spawn 入参只有 `{requestId,cols,rows,cwd}`，shell 选择在服务端从 settings 读**（`TerminalSettings.tsx:320-325`），这是 H5 端要镜像的关键点。

**实施方案（最小改动：只换 `browserHost.terminal` 底层，xterm 层零改动）**：

- **服务端 `src/server/services/terminalService.ts`（新增，~836 行）**：镜像 `electron/services/terminal.ts` 的 shell/cwd/env/min 尺寸/事件逻辑。`TerminalService` 构造注入 `ptyFactory`；`attach(ws)`（接管存活 PTY 发 `terminal_sync`）、`detach(ws)`（owner 置空起 15s 宽限，`CC_HAHA_TERMINAL_DISCONNECT_GRACE_SECONDS` 覆盖）、`spawn/write/resize/kill`（owner 校验）、`getBashPath/setBashPath`（读写 `terminal-config.json` 的 `bash_path` 键，路径 `CLAUDE_CONFIG_DIR` 或 `~/.claude`）。`findNodePtyDir` 候选链：`CC_HAHA_NODE_PTY_DIR`→`CLAUDE_APP_ROOT`（.asar→.asar.unpacked/node_modules/node-pty，否则 node_modules/node-pty 与 desktop/node_modules/node-pty）→cwd/desktop/node_modules/node-pty，须 `package.json` 且 `build/Release/pty.node` 或 `prebuilds/<platform>-<arch>/pty.node`。
- **WS 通道 `src/server/ws/handler.ts`**：`WebSocketData.channel` 扩 `'terminal'`；open/message/close 加 terminal 分支→`getTerminalService().attach/detach`+`handleTerminalMessage`。入帧 `terminal_spawn/write/resize/kill`，回帧 `terminal_spawned/terminal_error/terminal_output/terminal_exited/terminal_sync`。
- **REST `src/server/api/terminal.ts`（新增）**：`GET/PUT /api/terminal/bash-path`（PUT body.bashPath 须 string|null 否则 400）；`router.ts` 加 `case 'terminal'`。
- **WS 路由 `src/server/index.ts`**：在通用 `/ws/` 之前插 `/ws/terminal` 分支（字面路径否则被 `/ws/{sessionId}` 吞）。**本块归 h5-terminal-bridge.patch；require-token 的 `serverFetch` 抽取 + unix-socket 测试设施归 h5-require-token.patch**（两 patch 对 index.ts 的改动不相交）。
- **远程设置 `src/server/remoteBrowserPolicy.ts`**：`DESKTOP_TERMINAL_SHELLS=['','system','pwsh','powershell','cmd','custom']`+`isDesktopTerminalPatch` 校验；`projectRemoteSettings` 投 `desktopTerminal`；`validateRemoteSettingsPatch` 首行放行 `desktopTerminal` 键。（本文件另有 auto-mode-optin 的 `skipAutoPermissionPrompt` 改动，两 patch 不相交。）
- **前端 `desktop/src/lib/desktopHost/terminalWs.ts`（新增，~282 行）**：`TerminalWebSocketClient` 独立单条 WS 通道（不复用 wsManager，因 chat 的 `ServerMessage` 协议与终端帧不匹配）。`buildTerminalWebSocketUrl()`=getBaseUrl→`ws(s)://<base>/ws/terminal`+`?token=`；指数退避重连 `min(1000*2^n,30000)`；SPAWN_TIMEOUT_MS=10000；spawn/write/resize/kill；onOutput/onExit/onSync 返回同步 unlisten。
- **前端 `browserHost.ts`**：`capabilities.terminal` false→true；terminal 命名空间改 WS 实现（`supportsStartupCorrelation:true`，spawn/write/resize/kill/onOutput/onExit 走 `getTerminalWsClient`；getBashPath/setBashPath fetch `/api/terminal/bash-path`）。
- **H5 入口 `desktop/src/pages/settings/H5Settings.tsx`**：terminal 分支渲染 `<H5TerminalSettings/>`（`useSessionStore` 取 `activeSession?.workDir ?? projectRoot` 作 cwd 传 `TerminalSettings showPreferences cwd`）。（本文件其余 16-tab 结构归 h5-settings-parity.patch。）
- **xterm 层 `TerminalSettings.tsx` 零改动**：它只经 5 个 API（spawn/write/resize/kill + onOutput/onExit）与底层解耦，换底层即生效。

**关键 Bug：Bun 下 node-pty 12ms SIGHUP 秒退（生产必中招）**：
- 症状：dev 7788 WS 手测，spawn 成功回 `terminal_spawned` 但 ~12ms 后收 exit 帧 `code:0, signal:"1"`（SIGHUP），write 报 'terminal session is not running'。
- 根因（隔离实验定位）：node-pty 1.1.0 的 JS 胶水 `lib/unixTerminal.js:93 new tty.ReadStream(term.fd)` 在 **Bun 1.3.14** 下首次 EAGAIN 即关流（+11ms），关流触发 close handler SIGHUP 掉 shell。**Node 22 下同样代码正常**（子进程 state=S 存活）。原生 pty.node 本身没问题。sidecar 运行时恒为 Bun（dev `bun run`；生产二进制为 bun compile 产物）→ 生产也会中招，必须按 Bun 兼容修。
- 修复：绕过 node-pty 的 UnixTerminal，直接调原生 `pty.fork`（签名 `pty.fork(file,args,env[](k=v),cwd,cols,rows,uid,gid,utf8,helperPath,onexit)→{fd,pid,pty}`），master fd 用异步 `fs.read` 非阻塞读（EAGAIN/EWOULDBLOCK 时 `setTimeout` 15-20ms 退避重挂、有数据立即再读排空、EIO=child 退出）；write=`fs.writeSync(fd,data)`，resize=`pty.resize(fd,cols,rows)`，kill=`process.kill(pid,'SIGHUP')`，onExit 用 pty.fork 的 onexit 回调。保持 `TerminalPtyProcess` 接口不变（TerminalService 逻辑不动）。CPU：15-20ms 轮询空闲约 24-28%，可接受为 v1。死路（勿重试）：Bun 下 `net.Socket({fd,writable:true})` 写即关、readable-only 0 字节；`process.binding('fs')` 无 fcntl 无法 JS 侧改阻塞。
- 另修 `stopSession` 竞态：原实现先 `sessions.delete` 再 `pty.kill()` 导致退出事件找不到会话不发 exit 帧；改为置 `session.exited=true` 不删 map，让 pty 真实退出事件走 `removeSession` 发 `terminal_exited` 帧并清理，加 500ms unref timer 兜底。

**Bug 2（H5 LAN 访问）：`crypto.randomUUID` 非安全上下文抛错**（`TerminalSettings.tsx`）：
- 症状：H5 通过 LAN IP（`http://192.168.x.x:port`）访问点开终端直接报错；loopback（127.0.0.1）一切正常，故最初 live 验证全绿掩盖了它。
- 根因：`crypto.randomUUID` 仅在**安全上下文**（HTTPS 或 localhost/127.0.0.1）可用；LAN IP 走普通 http 是非安全上下文，`crypto.randomUUID` 为 `undefined`，`startTerminal` 里 `crypto.randomUUID()` 抛 `TypeError: crypto.randomUUID is not a function`，被 `catch` 捕获后显示在终端面板错误条。
- 修复：照抄 `McpSettings.tsx` 的 `createId` 范式，加 `createTerminalRequestId()` 回退（`typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : 't-'+Date.now()+'-'+Math.random().toString(36).slice(2)`）。独立 commit `71ac3073`。LAN live 复现：终端正常打开、`echo` 回显、console 无报错。

**验证**：
- 服务端单测：`src/server/__tests__/terminal-service.test.ts` 11/11（FakePty 注入）；WS 通道 `websocket-handler.test.ts` 103/103。
- 前端：`desktop tsc -b` exit 0；vitest `terminal.test.ts`(2)+`contract.test.ts`(10)=12/12；`vite build` 新 bundle。
- dev 7788 live（LAN 192.168.10.43 带 H5 token）：spawn→PROMPT→write `echo`→resize 100x30→kill→`terminal_exited{code:0,signal:"1"}` 帧全 ✓（`/tmp/ws-full-final.mjs`）。
- Patch：`modify/patches/h5-terminal-bridge.patch`（基线 2f8d819d，v0.6.6，12 文件 1961 行，4 个新文件带 `new file mode`）。**已验证 5 patch 全链（h5-require-token→h5-auto-mode-optin→session-export→h5-settings-parity→h5-terminal-bridge）`git apply` 干净应用，且逐字节等于当前工作树**（34 个覆盖文件 diff 全空）。

---

## 二、会话导出功能（源§三，✅ 2026-09-24）

### 需求背景

旧§三在 0.5.3 上实现：会话列表右键菜单新增「导出会话」，支持导出 **Markdown / HTML / 纯文本**，并可选导出范围（默认「最近一次压缩 → 最新消息」，可选具体压缩边界节点或「全部」）。0.6.6 中该功能不存在，本次以旧 fork 树（`CC-HAHA-Scode`）的完整实现为参考移植到 0.6.6 基座。

### 0.6.6 现状核对

- compact 边界 JSONL 行形态 `{type:'system', subtype:'compact_boundary'|'microcompact_boundary', content:'Conversation compacted'|'Context microcompacted', timestamp, uuid, ...}`（`src/utils/messages.ts:4744-4797` `createCompactBoundaryMessage`/`createMicrocompactBoundaryMessage`），**无 `message` 字段**。
- 服务端 `entriesToMessages`（`src/server/services/sessionService.ts:5183`）以 `if (!entry.message?.role) continue` 把所有无 `message.role` 的条目（含 compact 边界）过滤掉，且 `MessageEntry`（服务端 `:218` / 前端 `desktop/src/types/session.ts:46`）**无 `subtype` 字段** → 前端从 `/api/sessions/:id/messages` 拿不到边界节点，无法切分导出范围。
- 前端 API 方法 0.6.6 名为 `sessionsApi.getFullHistory(sessionId)`（`desktop/src/api/sessions.ts:447`，返回 `{messages, page}`），旧版用的 `getMessages` 已不存在。
- UI 已能渲染 compact：`mapHistoryMessagesToUiMessages`（`desktop/src/stores/chatStore.ts:7699-7708`）把 `type:'system' && content==='Conversation compacted'` 映射为 `compact_summary` → 放行边界条目与现有 UI 行为一致，无回归。
- 0.6.6 已具备所需 UI 原语 `Modal`/`SelectField`/`Button`（`desktop/src/components/ui/`）；右键菜单在 `desktop/src/components/layout/Sidebar.tsx`（「重命名」/「删除」项，H5 手机共用同一 Sidebar）。

### 实施方案

- **服务端**（`src/server/services/sessionService.ts`）：`MessageEntry` 加 `subtype?: string`；`entriesToMessages` 在 `if (!entry.message?.role) continue` 之前对 `type==='system' && subtype ∈ {compact_boundary, microcompact_boundary}` 特殊放行，push `{id, type:'system', subtype, content, timestamp}` 后 `continue`。其余逻辑不变。
- **前端类型**（`desktop/src/types/session.ts`）：`MessageEntry` 加 `subtype?: string`。
- **导出渲染器**（新增 `desktop/src/lib/sessionExport.ts`，移植旧实现 248 行）：`renderMessagesToMarkdown/Html/PlainText`（user→引用块 / assistant→正文 / system→斜体 / tool_use·tool_result→代码块；compact 边界渲染为分隔标注）；`collectExportNodes`/`isCompactBoundaryEntry`（按 `subtype` 判定）；`formatExportFilename`（`<时间戳>-<标题>.<ext>`）；`downloadExport`（Blob + `<a download>`，桌面/H5 浏览器通用）；HTML 内联 CSS 含深色模式适配。
- **导出对话框**（新增 `desktop/src/components/ExportConversationDialog.tsx`，移植 + 适配）：格式选择（md/html/txt）+ 范围选择（最近压缩→末尾 默认 / 各边界节点 / 全部）+ 下载；唯一适配点 `getMessages` → `getFullHistory`（`handleExport` 与 `ExportRangePicker` 两处）。
- **右键菜单**（`desktop/src/components/layout/Sidebar.tsx`）：加 `exportTarget` 状态；「重命名」与「删除」之间插入「导出」项（取会话 title）；组件返回体渲染 `<ExportConversationDialog />`。
- **i18n**（5 语言 en/zh/jp/kr/zh-TW）各加 6 key：`session.export.title/.export/.format/.range/.range.latest/.range.all`。

### 验证

- 类型：desktop `tsc -b` exit 0。
- desktop vitest：6137 pass，2 个既有失败（`providerModels.test.ts` / `MessagePayloadRetention.test.tsx`，未触及，不变）。
- 服务端 `bun test`：session 相关失败集（`sessions.test.ts`/`session-messages-http.test.ts`/`session-summary.test.ts` 共 5 个）在改动前后**完全一致**（stash 对比），确认本次 `entriesToMessages` 放行未引入新失败（其余 h5-access 失败属第一章 h5 改动域，环境/集成既有）。
- **live E2E（dev 7788，重启 sidecar 加载服务端改动）**：向会话 JSONL 追加一条标准 `compact_boundary` 行后，`GET /api/sessions/:id/messages?mode=full` 返回 11 条消息且其中 1 条 `subtype: compact_boundary`、`content: 'Conversation compacted'`、`id` 与 uuid 一致——边界节点端到端带出（验证后已还原 JSONL 为 25 行）。
- 前端 bundle：重 build 后 `session.export.*` 文案与导出组件均进 `App-*.js`/`i18n-*.js`，已伺服 7788。
- **待手机实测**：192.168.10.140 长按会话 →「导出会话」→ 选格式/范围 → 下载，核对 md/html/txt 内容与边界分隔。
- Patch：`modify/patches/session-export.patch`（基线 2f8d819d，v0.6.6，10 文件 588 行）。已验证 `git apply --check` 在**纯 v0.6.6 基线**与**基线+第一章 h5 patch 链式**下均可干净应用（i18n 与 h5 patch 各自 key 域不相交，应用顺序不限）。

---

## 三、会话刷新按钮（授权/提问卡住软刷新规避）（源§八，✅ 2026-09-24）

### 需求背景

会话中需要用户授权（can_use_tool）或提问问答（AskUserQuestion）时，有概率卡在「准备工具」不弹授权/问答对话框。根因是实时 WS 投递链路在特定条件下丢弃消息（`forwardCliMessageToSessionClients` 在 `clients.size===0` 时 return、`bindClientSessionOutput` 在 transcript epoch 不匹配时 return），而服务端 `pendingPermissionRequests` **总是完整记录**——刷新页面重连后服务端重放 permission 消息即可恢复。方案：手动「刷新会话」软刷新按钮，无需整页刷新。

### 0.6.6 现状核对（调研结论）

- **服务端重放机制已存在，无需新增**：`src/server/ws/handler.ts:639-646` 每个新连接/重连的 open 必发 `replayPendingPermissionRequests`（:4269-4286 逐条重发 `{type:'permission_request'}`）+ `{type:'permission_requests_snapshot', toolRequestIds, computerUseRequestIds, turnActive}`。
- pending 存储：`conversationService.ts:227-237` 内存 `Map<requestId,...>` 挂 session，不落盘；断连宽限 30 分钟（`handler.ts:162 PENDING_PERMISSION_DISCONNECT_CLEANUP_MS`）。**AskUserQuestion 与 can_use_tool 是同一套 pending 机制**（`tool_name:'AskUserQuestion'` 进同一个 `pendingPermissionRequests`）。
- 历史重拉：独立 HTTP API `GET /api/sessions/:id/messages?mode=full`（`api/sessions.ts:193-201`，读磁盘 transcript JSONL）——可补回 CLI 已写入的 AskUserQuestion tool_use。
- 前端现成 API：`chatStore.disconnectSession(id)`（:3180）→ `connectToSession(id)`（:2941，重连触发服务端重放+全新 bootstrap 拉历史）→ `reloadHistory(id)`（:4003，无 guard 调用时直接应用结果；与 bootstrap 有 lifecycleGeneration 协调，重复拉取幂等）。
- 挂载点：桌面 `SessionChatHeader` 已支持 `actions` prop（`SessionChatSurface.tsx:61` 渲染标题右侧）；移动端 `AppShell.tsx` `mobile-session-header`（0.6.6 只有侧栏 toggle 按钮，无菜单）。

### 实施方案（纯前端，7 文件 73 行）

- **handler（两处各一份，同逻辑）**：`useState refreshingSession` 防重入；`disconnectSession(activeTabId)` → 等 120ms → `connectToSession(activeTabId)`（服务端重放 permission_request/snapshot）→ `await reloadHistory(activeTabId)`（补 AskUserQuestion tool_use）。函数经 `useChatStore.getState()` 取（避免订阅 churn）。
- **桌面**：`desktop/src/pages/ActiveSession.tsx` 加 `handleManualRefresh`，按钮挂 `SessionChatHeader actions`（`Button variant="ghost" size="sm"`，`refresh` material icon，刷新中 `animate-spin`，`data-testid="session-manual-refresh"`）。
- **移动端**：`desktop/src/components/layout/AppShell.tsx` 加 `handleManualRefresh`（加 `isActiveChatTab` 门控），`IconButton` 挂 `mobile-session-header` 尾部（icon `refresh`/刷新中 `progress_activity`，`size="2xl"`，`data-testid="session-manual-refresh-mobile"`，仅 chat tab 渲染）。
- **i18n**：新增 `chat.refreshSession` 5 语言（en 'Refresh session' / zh '刷新会话' / zh-TW '重新整理對話' / jp 'セッションを更新' / kr '세션 새로고침'）。
- 参照旧 fork（CC-HAHA-Scode 2026-08）同功能实现，0.6.6 挂载点/组件名以本基座实际代码为准。

### 验证

- `desktop tsc -b` exit 0；vitest `AppShell.test.tsx` + `ActiveSession.test.tsx` 54/54 pass（chatStore mock 已含 disconnectSession/connectToSession/reloadHistory）。
- `vite build` 成功，新 bundle `App-BVVJKg7-.js`；dev 7788 伺服 dist/ 即生效（H5 会话页标题栏/移动端 header 右侧可见刷新按钮）。
- Patch：`modify/patches/session-refresh.patch`（基线 2f8d819d，7 文件 171 行）。**6 patch 全链（require-token→auto-mode-optin→session-export→settings-parity→terminal-bridge→session-refresh）`git apply` 全成功，结果与当前工作树逐字节一致（41 文件 0 差异）**。

---

## 四、实时解码速度（TPS）指示器（源§九）+ 手机端顶栏两行显示（源§十六，✅ 2026-09-24）

### 需求背景

会话流式输出时显示实时解码速度（token/秒），帮助用户感知模型吞吐；移动端顶栏空间有限，指示器改为两行竖排（TPS 标签 + 数值）。

### 0.6.6 现状核对

- 0.6.6 无任何 TPS 相关代码；chatStore 已有 `appendPendingDelta`（content_delta 缓冲，:1026 区）与 `appendPendingToolInputDelta`（工具入参流式 JSON 缓冲）——两处都是「新 token 到达」的准确喂入点。
- 无 `subagent_tps` 消息类型（老 fork 有，0.6.6 无）→ 该项省掉。**⚠️ 2026-09-27 更正：帧可以省，需求不能省**（子代理文本已随 `agent_run_event` 到达客户端，直接复用即可；省掉后近一天里子代理 TPS 形同虚设，详见下方 2026-09-27 子优化）。
- 桌面挂载选 `SessionChatHeader actions` 簇（与刷新按钮同侧），而非 metadata 行——metadata 行有「分隔符数量」契约测试（ActiveSession.test.tsx:2486），塞入会破坏「空闲会话恰 3 项 2 分隔符」断言。

### 实施方案（12 文件，3 新文件）

- **`desktop/src/lib/tpsMeter.ts`（新增，移植自老 fork）**：1.5s 滑动窗口字符增量→token/s；CJK≈1 token/字、ASCII≈1/3.5 字（`estimateTokens`）；会话结束瞬间 2s 平均 fallback 保持速度不骤降 0（`computeFallbackTps`，跳过最近 300ms 流切换）；`SPARSE_SPEED_THRESHOLD=5` 流边界（text↔thinking↔tool）稀疏读数回退 fallback。
- **`desktop/src/components/chat/TpsIndicator.tsx`（新增，移植+量身定制）**：180ms 轮询；四档着色 <27红/<53橙/<80绿/≥80紫；5 分钟空闲隐藏；组件内 30%+70% 指数平滑；**`vertical` prop 两行竖排**（移动端用）；opt23 §11.27 `Math.max(span, windowMs/1000)` 防移动端突发批量 content_delta 虚高；**硬编码中文改 i18n**（`useTranslation` + `chat.tpsSpeedTitle`/`chat.tpsLabel` 5 语言）。
- **chatStore 接入**：`tpsMeterBySession: Map<string,TpsMeter>` + 导出 `getSessionTpsMeter(sessionId)`（懒创建）；`appendPendingDelta`/`appendPendingToolInputDelta` 末尾 `if (isTpsEnabled()) meter.push(text)`（工具入参 JSON 也算解码速度）；`disconnectSession` 清理 `tpsMeterBySession.delete(sessionId)`。
- **挂载**：桌面 `ActiveSession.tsx` 挂 `SessionChatHeader actions`（TPS 在刷新按钮左侧，横排）；移动 `AppShell.tsx` mobile-session-header 刷新按钮左侧 `vertical` 两行。
- AppShell.test.tsx 的 chatStore mock 补 `getSessionTpsMeter` stub（hasStreamed: false → 指示器隐藏，不影响既有断言）。

### 验证

- `desktop tsc -b` exit 0；vitest `tpsMeter.test.ts` 4/4（fallback 保速/稀疏边界/350ms 跳过/token 估算校准）+ AppShell 22/22 + ActiveSession 32/32；全量前端 vitest **6141 pass / 2 fail**（2=基线既有 providerModels、MessagePayloadRetention，零回归）。
- `vite build` 成功，新 bundle `App-BTQt5ZiK.js`。
- 坑：TpsIndicator 早期 `if (!isTpsEnabled()) return null` 在 hooks 之后 → `useTranslation` 须声明在早退之前。
- Patch：`modify/patches/tps-indicator.patch`（12 文件 633 行，3 新文件 mode 100644）。

### 子优化（2026-09-25）：起步速度更准确 + 标签精简

- **起步速度修正（tpsMeter.ts）**：新增 `BURST_FLOOR_MS=400`，`value()` 改 `elapsed = Math.max(span, BURST_FLOOR_MS/1000)`（替换原 `Math.max(span, windowMs/1000)` + <0.05 外推分支）。作用=回合并流初期不再被摊到整窗 1.5s 而低估（20 token 突发从虚高 2000 降到 ~75），UI 30/70 指数平滑兜底。
- **标签去冗（TpsIndicator.tsx）**：桌面 `42 t/s`（删「TPS」词与 `chat.tpsLabel` 前缀，min-w-[6ch]）；移动两行 `TPS`/`42`（删 `t/s`）；title 保留 `chat.tpsSpeedTitle`。色档 27/53/80 未动。
- **i18n**：5 语言（en/zh/zh-TW/jp/kr.ts）删无引用的 `chat.tpsLabel` 行。
- 验证：tsc -b exit 0；全量前端 vitest 6144 pass / 2 fail（2=既有，零回归）；vite build `App-CJApNwcB.js`。
- Patch 重生成：`tps-indicator.patch` 12 文件 633 行（含子优化终态）。

### 子优化（2026-09-26）：thinking 计入 TPS + 保持值口径改为正文结束前 0.5s 平均 + 数字行居中

- **问题（用户反馈：「总显示在不对的速度上一动不动」+「thinking 没计入 TPS」）**：①thinking 走独立 WS 事件（handler.ts:3584 `thinking_delta`→`{type:'thinking',text}`），前端 `case 'thinking'`（chatStore.ts:5068）从不喂 TpsMeter → 整段思考零采样；②正文结束→窗口排空→稀疏守卫 `result<SPARSE_SPEED_THRESHOLD(5)` 冻结→fallback 停在正文结束前旧值（`value()` 里 `if(result>0) this.fallbackTps=result` 死代码分支让 shrinking 窗口持续覆盖保持值，是卡住的帮凶）。
- **修复 3 文件**：
  - **chatStore.ts `case 'thinking'` 末尾**：`skippedThinkingBlock===false && isTpsEnabled()` 时 `getSessionTpsMeter(sessionId).push(msg.text)`——thinking 也是 decode 输出 token；整块重放（skipped）路径不喂避免重复计数。
  - **tpsMeter.ts 保持值口径**：`FALLBACK_WINDOW_MS` 2000→**500**、`FALLBACK_SKIP_MS` 300→**0**，即保持值=最后一个 chunk 前 0.5s 的平均速度（用户指定口径）；删 `value()` 里 shrinking 窗口覆盖 `fallbackTps` 的分支，保持值现只由 `push()` 刷新。其余常量不变（WINDOW_MS=1500、BURST_FLOOR_MS=400、SPARSE_SPEED_THRESHOLD=5、CJK 1:1/ASCII 1:3.5）。
  - **TpsIndicator.tsx**：vertical 数字行 `min-w-[7ch] text-right`→`text-center`（与 TPS 标签共享中心轴，对齐修复）。
- **验证**：`bun /tmp/tps_check2.ts` 数值全对（稳态 80/s 停止后保持 84≈80、加速尾正确、thinking-fed 跟随不再冻结）；chatStore.test 347 + chatStore.golden 14 + tpsMeter.test 4 = **365/365**；全量前端 vitest **812 pass/2skip** + 12300 pass/12skip/0fail 零回归（基线）；tsc 仅 TS5096 非阻断；grep dist 确认 `FALLBACK_WINDOW_MS=500` 孪生已同步（.js 孪生坑照例 `tsc -p --noEmit false` 重发）。
- **Patch 重生成**：`tps-indicator.patch` 12 文件 **654 行**（3 章内文件 hunks 更新，9 共享文件不变；3 文件不在后续 patch 中，19 链顺序 apply 全 OK，逐字节=工作树）。

### 子优化（2026-09-26）：子代理 TPS 汇聚到主会话显示

- **需求**：会话并发跑子代理（Agent 工具）时，主会话 TPS 只反映主线程自身 decode；子代理输出应汇聚进同一指示器，并显式标注子代理数量。
- **实现 4 文件**：
  - **tpsMeter.ts**：新增 `aggregateMeterReadings(own: TpsMeter, subs: TpsMeter[], now: number, idleMs: number): {visible, tps, activeSubs}`——主会话速率 + 所有**窗口内仍有采样**（live）的子代理速率求和；已排空的子代理（结束）用自身 fallback 保持值不再计入（防膨胀），`activeSubs`=live 计数；idle（5min 无采样）整体隐藏。纯函数便于单测。
  - **chatStore.ts**：`subordinateTpsMetersBySession` Map（sessionId→子代理 meter 数组），导出 `getSubordinateTpsMeters(sessionId)`；子代理会话的 content_delta/tool_input_delta 推入对应子 meter（经会话父子关系归属）。
  - **TpsIndicator.tsx**：改用 `aggregateMeterReadings` 渲染；`activeSubs>0` 时显示 `Σn` 徽章（data-testid `tps-subagent-badge`），title 切换 `chat.tpsAggregateTitle`（含 `{count}` 占位）。
  - **i18n**：5 语言新增 `chat.tpsAggregateTitle`（插在 `chat.tpsSpeedTitle` 行后）。
- **验证**：tpsMeter.test（aggregate 4 用例：求和/排空子代理不计/单会话等价/idle 隐藏）+ TpsIndicator.test（新文件 3 用例：Σ 徽章/排空后消失/未流式隐藏）= **11/11**；chatStore 358/358；tsc exit 0；vite build `App-C1OyVXUg.js`（grep 确认 `tps-subagent-badge`/`tpsAggregateTitle` 入包）。
- **Patch 重生成**：`tps-indicator.patch` 13 文件（含新测试文件 new file mode）929 行。因新 i18n 键插入在 `chat.tpsSpeedTitle` 后，**连锁重生成**下游锚定该区域的 `file-download.patch`（20 文件 951 行）与 `h5-mobile-quick-actions.patch`（9 文件 481 行）；19 链 worktree 顺序 apply 全 OK，与工作树逐字节一致（仅 5 已知非章 delta）。
  - 坑：fd/mqa 重生成须以「工作树终态区块逐字取用」法（en/zh-TW 的 `chat.downloadableFiles`+`chat.downloadableMore` 同行双键、尾随空行都是工作树原貌）；以旧 commit（c1bacc0c）为基底会带入已删的 `chat.tpsLabel`。

### 子优化（2026-09-27）：子代理 TPS 真正汇聚——修复「不打开子代理页就完全不计入」

- **问题（用户 verbatim）**：「主会话分派的子代理在运行过程中的 TPS 似乎还是没有汇聚到主会话的 TPS」——上一版（2026-09-26）按「tab 归属」聚合，实际几乎永不生效。
- **根因（两层，缺一即失效）**：
  1. 子代理的流式文本走 `agent_run_event`（内层即 `content_delta`/`thinking`），客户端 `dispatchAgentRunEvent` 只有在 `registerAgentRunSession` 登记过路由时才会应用到 run 会话并喂 run 米表；而该登记**只在 SubagentRunPage 挂载时发生**（`openSubagentTab` 只由用户点开触发）。
  2. 未打开子代理页时事件落入 `bufferAgentRunEvent` 缓冲、**没有任何米表被喂**；同时 `getSubordinateTpsMeters` 按 `tab.type==='subagent' && tab.sourceSessionId===父` 找米表，tab 不存在 → 返回空。
  - 结果：既无 run 米表、也无下属米表 → 主会话永远只显示主线程自身速度。
- **对照老 fork（`CC-HAHA-Scode`）的正确机制**：老树走**服务端中转**——`AgentTool/runAgent.ts` 在子代理流循环里对每个 `text_delta`/`thinking` 调 `emitSubagentTps()`（`utils/sdkEventQueue.ts`），经 WS `handler.ts` 转成独立帧 `{type:'subagent_tps', text}`，前端 `chatStore` `case 'subagent_tps'` **只喂父会话米表、不渲染**。即「父米表本身就是团队总量」，与页面是否打开无关。
- **本次实现（照搬老树语义，但无需新增 WS 帧）**：0.6.6 的子代理文本**已经**随 `agent_run_event` 到达客户端（老树无此路径，才需要专门造帧），故直接复用：
  - **chatStore.ts**：`handleServerMessage` 的 `agent_run_event` 分支在派发**之前**调 `ingestSubagentTps(parentSessionId, msg.event)`——`content_delta` 的 `text`/`toolInput`、`thinking` 片段（`complete !== true`）推入**父会话**米表。只碰米表，不进 `streamingText` → 子代理正文不会泄漏到主会话。
  - **tpsMeter.ts**：`aggregateMeterReadings` **不再求和**下属速率——父米表已含子代理 token，下属米表降级为「活跃计数」来源（`activeSubs` → Σn 徽章）；求和会把同一批 token 计两次。
- **踩坑记录（本项）**：
  1. **「按 tab 找下属」的聚合设计天然失效**：tab 是**渲染态**产物（用户点开才有），拿它当数据来源等于「打开子代理页才聚合」——与「后台跑子代理时主会话要显示总速率」的需求正好相反。**数据源必须是随帧到达的事件，不是 UI 状态**。
  2. **「省掉无对应消息类型的功能」是伪简化**：当初核对时见 0.6.6 无 `subagent_tps` 帧即判「该项省掉」（本文档 §四 现状核对原文）。省掉的是**帧**，不是**需求**；替代路径（agent_run_event）当时已存在却被漏看，功能因此形同虚设。
  3. **thinking 整块重放不能重复喂**：`thinking` 事件既可能是片段（`thinking_delta`）也可能是**整块**（`complete === true`，其片段已先到达），两者都喂会让速率翻倍 → 只喂片段。
  4. **转发与求和不可并存**（双计）：转发后父米表已是总量，旧的「own + 下属求和」必须同步去掉，否则打开子代理页时速率瞬间翻倍。
- **验证**：`tpsMeter.test`（聚合用例改为「不重复叠加」+ 新增「仅下属流式时隐藏」）+ `chatStore.test`（新增：未打开的 run 其 decode 文本进父米表且不伪造会话状态、整块 thinking 不重复计数）= **370/370** 通过；`tsc --noEmit` 0 错。
- **Patch 重生成（链位差分法，本次）**：
  - **`tps-indicator.patch`**（链位 7）：8 文件 **839 → 895 行**。重生成 `tpsMeter.ts` / `tpsMeter.test.ts`（本章独有新文件，按工作树终态取用）+ `chatStore.ts`（在链位现场 S_pre=`cee7fe4c` 上手改后取 diff）；其余 5 个 section（TpsIndicator×2 / AppShell×2 / ActiveSession）未动。
  - **`turn-usage.patch`**（链位 31）：12 文件 **637 → 679 行**。`chatStore.test.ts` 是**末位触碰它的 patch**（#23 也在该文件，其 import hunk 上下文正好覆盖我要插入的行），故新增测试的归属放这里；按 `diff(S_post30 → 工作树)` 重生成该 section。
  - **验证**：干净 worktree@`068b3ebd` 按表序（1→35，非字母序）`git apply --allow-empty` **全部 35 个 patch → 失败 0**；第 7 章 8 文件与 `chatStore.test.ts` 终态**逐字节等于工作树**（`chatStore.test.ts` 由 delta 归零）。

### 子优化（2026-09-27）：TPS 采样改真实 token 口径——自适应三层源 + 真实对账校准

> ⚠️ **2026-09-27 后续更正（本条设计已被替换，见下一条「TPS 计量改为按内容度量」）**：本条的「无 ids 时按帧计数（chunk 层）× 学习到的每帧 token 数」在**6 并发子代理**下把读数抬到真实值的 **2~3 倍**（面板 ~800 tok/s，引擎日志实为 ~250~290）。原因是「每帧多少 token」随内容种类相差约 40 倍（文本帧 ~2.5、thinking ~12、工具入参 JSON ~90~220），单个全局系数会被工具入参那次调用污染到夹逼上限。以下保留原始记录，**现行为按内容度量**。

- **问题（用户 verbatim）**：「校正一下 TPS 采样是按实际 token 情况来的还是估算值」→ 核实结论：**一直是字符估算**（`estimateTokens`：CJK 1 token/字、ASCII 1/3.5 字、空白不计），全链路没有任何真实 token 接入。
- **用户要求（verbatim 意图）**：「尽量不要依赖后端引擎，采用 cc-haha 自身能适应各种情况：后端能发 token ids 则走 ids 采样；无 ids 则走 chunk 采样；无 ids 无 chunk 则走兜底估算」。
- **实测偏差（本会话 1010 次真实 API 调用离线对照）**：估算/真实 中位比值 **0.77**（偏低约 23%），中位相对误差 23.6%、P90 51.2%。
- **实现：三层源自适应 + 真实对账（`desktop/src/lib/tpsMeter.ts`）**
  - **`ids`（精确）**：代理把引擎每个 chunk 的 `token_ids` 计数经 `tps_tokens` WS 旁路送达；窗口直接求和，**无需校准**。
  - **`chunk`（主采样）**：无 ids 时每个流式帧 = 1 单位，`kChunk` = 学到「平均每帧 token 数」（1 chunk/token 引擎直接精确；3/5 token 一帧时由 k 吸收）。
  - **`char`（兜底）**：整块投递（`thinking.complete===true`、非流式整段）没有帧可数，按帧内文本 `estimateTokens` 加权，系数 `kChar`。
  - `chunk` 与 `char` 同时存在时按**近期残差**加权（误差小者权重高，夹逼 [0.2,0.8]），两类误差来源不同（批量分布 vs 中英混排）可互补降方差。
  - **真实对账**：每次 `message_complete` 用真实 `usage.output_tokens` 校准——**坐标下降**（固定一个系数解另一个，使混合总量等于真实值），夹逼 k∈[0.25,8]，`real<50` 或单位数<5 不学，单次单位数 > 均值×3 判为 fallback 重放并丢弃；按 **model** 分桶持久化（`cc-haha.tpsCalibration`，≤32 个模型 LRU）。
  - **真实锚**：空闲保持值 = `output_tokens / decode_ms`（`timing.decode_ms` 有则用），否则用「本轮首帧→末帧」观测跨度——**静止时显示的是真实速率**。
- **P1 精确通路（引擎可选，不依赖）**
  - 请求：`return_token_ids: true`（vLLM 系扩展）。**门控**：`passTokenIds` 仅当 baseURL 是**本机/私网**（引擎所在），或 provider 显式声明 `tokenIds: 'supported'`；`'unsupported'` 时绝不发（真 OpenAI 会因未知参数 400）。运行期另有「连续 2 次流式响应无 token_ids → 记该 origin 不支持」的内存记忆。
  - 解析：`openaiChatStreamToAnthropic` 读出 `choices[0].token_ids`（**旁路**，不进 Anthropic 流），按 ~200ms 聚合经回调交给代理层。
  - 回传：新增 WS 事件 `{type:'tps_tokens', tokens}`。因 `ws/handler → titleService → proxy/handler` 已构成链路，代理**不能**直接 import ws（会成环），故新增注册式 sink（`src/server/proxy/tpsTokenSink.ts`），在 `index.ts` 组装根注入 `sendToSession`。
  - 客户端：收到 `tps_tokens` 即切 `ids` 源并 `reset()` 窗口（避免新旧单位混算），此后该会话**文本帧只保活不计入**（同一批 token 会被文本帧重复表达，双计即 9999 那类爆表）。
- **踩坑记录（本项）**
  1. **「流式直接按真实 token」在标准 OpenAI/Anthropic 流里不存在**：真实 `usage.output_tokens` 只在**每次调用结束**到达，流中只有文本增量——所以「实时」与「真实」天生冲突，只能靠「采样 + 对账校准 + 真实锚」逼近，或依赖引擎扩展（token ids）。
  2. **对账的分摊数学踩坑（重要）**：最初按「预期份额分摊 real 再各自学 k」，结果两个估计器各学了一半 → 混合后总量腰斩（实测 80 → 40）。正确做法是**坐标下降**：固定一个系数，解另一个使混合量等于真实值（且第二个用第一个更新后的值，保证本轮即自洽）。
  3. **`external` 标记不可省**：子代理文本折进父米表，但子代理的 API 调用真实 usage **不会**到达父 socket；若这些帧也算进父会话的「本次调用单位」，父的 k 会被污染。故子代理帧带 `external: true`：进窗口、不进对账。
  4. **小样本会毒化系数**：单帧调用若参与学习，会把 k 顶到夹逼上限（实测单帧 120 token → k 直接 clamp）。故加 `MIN_UNITS_TO_LEARN=5` 与 `MIN_REAL_TOKENS_TO_LEARN=50` 双阈值；小调用只贡献「真实锚」不学系数。
  5. **换模型要用「记录中的旧模型」存档**：UI 会先把 selection 切到新模型，等 `runtime_config_applied` 到达时再按当前 selection 存档就会把旧系数写到**新模型**名下（实测：切换后系数没被重置）。故维护 `tpsCalibrationModelBySession` 记录米表所属模型。
  6. **中性值不该写盘**：`endCall` 改回传「是否真学到」，否则每个会话都会把 {1,1} 持久化，让「无数据」看起来像「已校准」。
  7. **精度预期要诚实**：离线验算 70/30 训练验证显示，**char 兜底层**校准后中位误差 23.6% → **14.7%**，到不了 ±3%——逐次误差主要来自分词器细节（特殊 token、空白折叠、数字/代码），文本层面不可还原；按内容种类（正文 vs 工具 JSON）分系数也无效（拟合出 1.095 vs 1.134）。真正精确靠 **chunk 层**（帧由引擎量化；投机解码下 k 吸收每帧 token 数，均值自洽）与 **ids 层**（精确）。另注：char 层对「以工具 JSON 为主」的调用系统性偏低（real/est 中位 1.50）而纯正文接近 1.05，全局 k 只能取折中。
  8. **策略门禁顺手修**：本项验证中发现 `check:policy` 的 dead-imports 规则一直在红（来自十三章 vcc 移植的 3 处未引用导入：`compact.ts` 的 `isEnvTruthy`、`vcc/vendor/core/build-sections.ts` 的 `clip`、`vcc/vendor/types.ts` 的 `Message`）；该规则的既定口径是「删掉」而非加白名单，已一并删除。
- **边界（已知且如实告知）**：① 子代理**拿不到**真实 usage/token ids（`agent_run_event` 只带文本）→ 其贡献只能是采样值套父会话同模型的 k；`tps_tokens` 也到不了父 WS（只送达订阅该 run 会话的客户端）。② `tps_tokens` 仅在引擎支持时存在；不支持则自动降级为 chunk/char。
- **验证**：`tpsMeter.test` 15（三层源/对账收敛/夹逼/离群/切源 reset）、`tpsCalibration.test` 8、`TpsIndicator.test` 5（含 `data-tps-source` 与 `≈` 标注）、`chatStore.test` 366（含「未打开的 run 文本进父米表」「子代理帧不参与对账」「重连清窗」「换模型存档」「ids 精确且抑制文本」）；桌面 `tsc --noEmit` 0 错；服务端 `bun test src/server` **3458 pass / 0 fail**；`check:policy`（dead-imports/module-graph/change-policy/changed-files）**全绿**。
- **UI 可见性**：TPS 指示器新增 `data-tps-source`（`ids`/`chunk`/`char`），非 ids 源时 title 追加 ` · ≈`，一眼可辨「精确 / 校准」；视觉与封顶/平滑/Σn 徽章不变。
- **入库**：链位 **37** `patches/tps-real-token-accounting.patch`（20 文件 1717 行，桌面 + 服务端同链）；dead-import 清理单列链位 **38** `patches/compact-dead-import-cleanup.patch`（3 文件 36 行）。两条补丁均为「链终态（改前）→ 工作树（改后）」的干净差分，故 **#1..#36 无需重生成、无级联**（TPS 改动不落在这 36 条的 hunk 上下文里）。

### 子优化（2026-09-27）：面板「生成速度」分子分母配对 + transcript usage 去重丢 output 修复

- **触发（用户 verbatim）**：「这个会话里面，最后执行的轮次，上下文浮动卡片里面的生成速度显示 6044tok/s，这是很不合理的。你需要检查一下。」
- **定位**：显示的是上下文浮动卡片的**会话累计**生成速度（`contextIndicator.sessionSpeed`，单位 `tok/s`）= `totalOutputTokens / totalDecodeDuration`。会话已锁定为用户提问的那个（DB 里标题「请用三句话简单介绍你自己，先深度思考再回答。」）：主会话 25 次调用 Σoutput=**24,356**，另有 **68 个子代理** Σoutput=**382,443**。显示 6044 意味着分母只有 ~67 秒（或按主会话 4.0 秒），**分母比真实少一到两个数量级**。
- **缺陷①：分母只由流式路径喂，分子收全量 token**
  - 分母来源唯一：`QueryEngine.ts` 在流式 `message_stop` 时 `addToTotalGenerationDuration(message.decodeMs)`；`decodeMs` 由 `StreamDecodeSpan`（首个生成 delta → 流结束）量出；流没有 `message_stop` 时按 0 计（注释明写 0 = "unknown, not instant"）。
  - 分子却覆盖**每次调用**：`src/services/api/claude.ts` 的 `finally` 里，流式走 `hasStreamingUsage` 分支，**非流式回退（`fallbackMessage`）单独一条 `addToTotalSessionCost`** 也把 usage 记进会话总量。回退请求没有流事件 → `decodeSpan` 从未开启 → **token 记全、时间记 0**。
  - 你的环境恰好大量走回退（本地引擎经 responses 端点 400/404 触发 `streaming_fallback`），于是分子累积、分母几乎不涨 → 6044。
  - **修复**：新增配对计数 `totalTimedOutputTokens`（只累加「确实量到 decode span 的那次调用」的 output token）：`state.ts` 的 `addToTotalGenerationDuration(decode, ttft, outputTokens)`、`getTotalTimedOutputTokens()`、随 resume 快照往返（`lastTimedOutputTokens`）；`QueryEngine` 传入 `currentMessageUsage.output_tokens`；面板 `deriveSessionUsageMetrics` 改为 **paired 分子 ÷ decode**，落盘快照缺该字段（旧快照）或整个会话无任何 span 时，才退回 `totalOutput / totalAPIDuration`（`totalAPIDuration` 由 `logging.ts` 每次调用都记，回退也涵盖，是唯一与全量 token 匹配的分母）。
  - 顺带修正 `desktop/src/api/sessions.ts` 里与实现相矛盾的注释（原文写「面板 tok/s 用 totalAPIDuration」，代码实际优先 decode）。
- **缺陷②：transcript usage 去重保留「首行」，而首行 output 恒为 0**
  - 真实 transcript 里**一次调用写两行 usage**：首行 `(提示总量, output 0, cache 字段 undefined)`（message_start 时写），末行 `(未缓存输入, output, cache_read, cache_create)`（最终用量；实测 `1129 + 29376 = 30505` 正好等于首行）。全量 1227 个 message id 的形状分布证实：**前若干行 output=0，末行才是真值**。
  - 服务端 `claimUsageRecord` 按 message id 首次为准 → 计入首行 → **output 与 cache_read 全丢**。实测 `f1be2b52` 走 transcript 口径时接口返回 `totalOutputTokens: 0`（真实 24,356），面板因此显示 0 tok/s、缓存命中 0%。
  - 同一根因还打到**本地索引**（`transcriptReducer`，同款 `usageRecordKey` 首次为准）：DB `activity_daily_models` 里两个会话**每一行**都是 `output_tokens = 0, cache_read = 0` —— 会话列表/活动统计的 token 与缓存命中数据一直是错的。
  - **修复**：两处都改为**保留每个 key 的末行**。`sessionService`：`claimUsageRecord` 返回 `{key, previous}`，末行先**回退**上一版贡献（从同一 model 桶与总数里减掉）再加新值，`countedUsage` 由 `Set` 改 `Map<key, 贡献>`。`transcriptReducer` 同法（`Map<string, CountedUsage>` 随投影克隆、`releaseCountedUsage` 负责回退，含 advisor 子键）。
- **踩坑记录（本项）**
  1. **「取逐字段最大」是错的**：首行 input 是**提示总量**、末行 input 才是**未缓存部分**（缓存部分在 cache_read）。若按字段取最大，input 会拿到提示总量而 cache_read 又单独计入 → `promptTokens` 把缓存重复计一遍（`1129+29376` 被算成 `30505+29376`）。正确规则是**整行取末**。
  2. **不要臆测「值小=不完整」**：`(3705, 0, 40320)` 重复三行后才出现 `(3705, 475, 40320)`——首行连 cache_read 都已带上，只有 output 是 0。所以判定依据只能是「行序」，不能是字段大小。
  3. **既有单测把「重复行数值相同」当成前提**（`counts a multi-block assistant reply once`），末行替换法在这种前提下结果不变，故无需改这些测试；但**必须新增**真实形状（首行 output=0 → 末行真值）的用例，否则回归覆盖不到真 bug。
  4. **`ContextUsageIndicator.test.tsx` 用「有 decode 无配对 token」的快照断言 200 tok/s**：契约一变它立刻变红（退回 API 口径得 57 tok/s）。旧快照语义变了必须显式改测试，而不是让代码去兼容旧数据。
  5. **`bun test src`（整树）不是有效回归信号**：整树合跑出现 3114 条失败（含桌面 vitest 用例名），而单文件跑 94/94 全过——仓库自己的 runner 是**按文件隔离**跑（`scripts/pr/run-server-tests.ts`），既定基线口径是 `bun test src/server`。判定回归一律用后者（本次 3458 → **3460** 全绿，多出的 2 条即本轮新增用例）。
  6. **诚实边界**：配对口径修正后，面板对「大量非流式回退」的会话会显示**较小但真实**的速度（只覆盖被测到 span 的调用），而不是一个漂亮的假数字；子代理的 token/时间都进会话总量，故其占比高的会话同样只按被测部分显示。
- **验证**：`sessionUsageMetrics.test` 24（新增「只除同批 token」「无配对 token 时退回 API 口径」）、`state.generationTiming.test` 3（span 缺失不计时间也不计 token）、`sessions.test` 316（新增末行计价用例）、`transcriptReducer.test` 31（新增末行替换用例）、`ContextUsageIndicator.test` 27；桌面 `tsc --noEmit` 0 错、`vitest run` **6290+ 全绿**；根 `tsc --noEmit` 0 错；服务端 `bun test src/server` **3460 pass / 0 fail**；`check:policy`（dead-imports/module-graph）全绿。
- **入库**：链位 **39** `patches/session-speed-and-usage-pairing.patch`（13 文件 1183 行）。同样是「链终态 → 工作树」干净差分，**#1..#38 不动**。

### 子优化（2026-09-27）：TPS 计量改为按内容度量——修复「6 并发子代理时聚合读数约为真实值的 2~3 倍」

**触发（用户 verbatim）**

> 「还有"请用三句话简单介绍你自己，先深度思考再回答。"这个会话里面我让开6个子代理测试性写文案，发现聚合TPS达到了800+，而实际上本地后端引擎控制台日志显示只有400左右。你也调研核对一下。」

**一、先定引擎口径（用户提问，已用日志算术判定）**

用户提出「后端引擎就是 Avg generation throughput + Accepted throughput 两个产出相加作为总 token 输出速度」。用本机 `G27.log` **541 个 10s 窗口**做算术核对：

```
每步 drafted = 5（num_speculative_tokens）
每位置接受率 0.661+0.391+0.227+0.153+0.107 = 1.539 → 平均接受长度 2.54（= 1 验证 token + 已接受草稿）
步频 = Drafted/5 ÷ 10s = 99 步/s
真实产出 = 99 × 2.54 = 251 tok/s
Avg generation throughput = 249.8 tok/s     ← 吻合
Accepted throughput       = 151 tok/s       ← 已含在其中
```

`gen×10 ÷ (步数×平均接受长度)` 在**全部 541 个窗口的中位数 = 1.000**。**结论：`Avg generation throughput` 本身就是真实产出，`Accepted throughput` 是它的子集（草稿被接受的那部分），两行相加会重复计**（接受率越好虚高越多，本例 ≈1.6×）。此为**该引擎该配置**（dflash `num_speculative_tokens=5`）的判定；若换配置需重跑同一算术。

**二、实况复现（探针 + 引擎日志同刻对照）**

在用户指定的会话（`f1be2b52`，标题「请用三句话简单介绍你自己…」）内发「重新执行一次」，同时：① 用 WS 探针逐秒统计帧通道；② 采集引擎吞吐行。引擎侧确认 `Running: 6 reqs`（六个子代理），真实产出 gen 250~350 tok/s。

探针实测（6 并发主时段）：
```
own 帧 ≈ 0（父会话自身几乎不产出）
sub 帧 ≈ 96~102 帧/秒        sub 字估 ≈ 250~530/秒
ids 帧 = 0（tps_tokens 从未发出）
```

**三、根因（两条独立缺陷）**

1. **`kChunk` 被工具入参污染到夹逼上限**：父会话那次调用真实 `output_tokens = 1627`（think 242 字 + text 65 字 + 6 个 Agent 输入 JSON 共 2464 字符），而客户端只看到 ≈32 帧（6 帧就装下 2464 字符 ≈ 90~220 token/帧）→ 对账算出 `kChunk ≈ 51`，被 `K_MAX=8` 截断。此后子代理的**稀疏文本帧**（~2.5 token/帧）被按 8 倍计：`100 帧/s × 8 ≈ 800/s` ✓ 与用户看到的数一致。
   根因一句话：**一个「每帧多少 token」的全局系数，去套密度相差 ~40 倍的帧**（且客户端还会合并 delta，帧数本身受节流影响）。
2. **`ids` 通路实际是死的**：`x-claude-code-session-id` 头只有 sidecar 自己的 `titleService`/`autoQuestionDecisionService` 会带，主会话的 API 请求**不带** → 代理层 `buildProxyTraceContext` 返回 null → `tps_tokens` 永不发出（探针 0 帧印证）。另外 `windowTokens()` 里 `ids` 只在「窗口内仅有 ids 样本」时才独用，混入任何文本样本就变成 `ids + 文本估算`，**同一批 token 会被计两次**。

**四、修复（设计替换，非补丁）**

- **以「内容度量」取代「帧计数」**：`tokens ≈ kCjk × CJK字符数 + kAscii × 非CJK字符数/3.5`。文本长度是**密度无关**的直接测量（不管引擎一帧塞几个 token），帧计数降级为**保活与时间跨度**用途。
- **两系数而非一个**：实测同类引擎上 CJK 散文 ≈1.0 token/字符单元，JSON/代码 ≈1.9（短 token + 密集标点），单个系数会在两类内容间差 2 倍。两系数用**最小二乘**（带遗忘因子 0.9，夹逼 [0.25,6]）从每次调用的（两类单元数，真实 `output_tokens`）一起学出，按模型持久化（`cc-haha.tpsCalibration`，v2；旧 v1 载荷直接丢弃）。
- **方程不足时的退化解**：只有一次调用（含两类但不可分离）或只出现一类时，退化为单系数解 `k = Σy(c+a)/Σ(c+a)²`，**且只写实际出现过的类**——否则一次纯 JSON 调用会把 `kCjk` 也拉高，让下一段中文回复按代码密度计价。
- **`ids` 独占**：窗口内只要存在 ids 样本就只返回 ids（中继覆盖该会话 socket 上的全部调用，含子代理）。
- 删除：`kChunk`、`blendWeightFor`/`errChunk`/`errChar` 混合权重、`wholeBlock` 的会计含义（`wholeBlock` 参数保留但不再改变计量）、`TpsSource` 的 `'chunk'`（现为 `'ids' | 'char'`，指示器 `data-tps-source` 同步）。

**五、修复后实测（同一会话、同一 6 并发场景）**

| | 面板中位 | 引擎 gen 中位 | 比值 |
|---|---|---|---|
| 修复前 | ~800 | 290 | **~2.8×** |
| 修复后（本轮） | 363 | 290 | **1.25×** |

修复后那一轮 `calls=0`（父调用在 240s 窗口内未结束），即**系数始终是中性 1.0 的最差情形**；残余 1.25× 正是「该语料 CJK 实约 0.8 token/字符、中性值按 1.0 计」之差，调用结束学习后应收敛。另外面板读数范围 259~560，与引擎 gen 的 205~363 同量级（修复前是数量级偏离）。

**踩坑记录（本项）**

1. **「每帧一个 token」只在均匀流成立**：本机引擎带投机解码且客户端会合并 delta，实测文本帧 ~2.5、thinking ~12、工具入参 JSON ~90~220 token/帧。**任何「单位计数 × 学习系数」的方案都必须先证明单位密度同质**，否则要把系数按内容类拆开。
2. **系数污染是永久性的、且方向最坏**：被污染到上限后一直偏高（用户看到的是持续 800），不会自愈——因为子代理帧是 `external`、其真实 usage 永远不到达父 socket，**驱动显示的那部分流量永远不参与对账**。
3. **「引擎两行相加」不是通用口径**：本机 dflash 配置下 gen 已含 accepted（541 窗口中位比 1.000）。若照「相加」当基准去校准，会把面板系统性地往高调 ~1.6 倍。**基准必须先做算术核对**，不要凭手感（用户也是自觉「好像是」才让我核）。
4. **`ids` 通路要有「是否真的在发帧」的探针**：设计上写了「引擎可选中继」，实际上主会话不带 session 头 → 永不触发。**只测单元测试会漏掉**（我此前只测了「收到 tps_tokens 后如何算」），必须实测线上帧通道。
5. **文本度量也有残余偏差**：ASCII 散文（≈0.875）与 JSON/代码（≈1.9）同属 `kAscii` 一类，二者仍差 ~2 倍。要再细就得按「标点密度」再分类，本轮不做（速度指示器 ±20~30% 可接受），**如实记录**。
6. **突发瞬时值仍会尖峰**：6 帧装 1880 字符的 Agent 入参在 ~0.4s 内到达时，`BURST_FLOOR_MS=400` 的下限会把窗口速率抬到 4700 t/s（UI 30/70 平滑后只闪一下，且封顶 9999）。属既有平滑策略的已知行为，未在本轮改动。
7. **`isTpsEnabled` 差点被删掉**：重写 `tpsMeter.ts` 时漏了它（`TpsIndicator`/`chatStore` 都在 import），`tsc` 直接报 TS2305——**重写整文件前先 `grep` 该模块的全部导出**。

**验证**：`tpsMeter.test` 18（含两条新回归：①「工具入参密帧不得按自身密度计费稀疏散文帧」②「CJK/latin 两密度可分离」③「实测混合调用可被预测在 ±5% 内」）、`tpsCalibration.test` 8（v2 形状 + 跨版本丢弃）、`TpsIndicator.test` 5、`chatStore.test` 366；桌面 `tsc --noEmit` **0 错**；受影响四套 **397/397**；全量回归见下。实况验证见上表。

**入库**：链位 **40** `patches/tps-content-accounting.patch`（8 文件 1016 行）。为「链终态（39 链）→ 工作树」的干净差分，**#1..#39 不动、无级联**（已在该终态上 `git apply --check` 通过）。

### 子优化（2026-09-26）：TPS 展示改造——去椭圆背景 + head 栏两行 + "TPS XXXt/s" 格式（commit 966ca8f1，#82）

- **需求（用户 verbatim）**：「TPS 显示应该是"TPS XXt/s"」——去椭圆背景改纯文字，桌面 head 栏改两行堆叠（费用上、TPS 下），TPS 与数字间留白。
- **实现 3 文件**：TpsIndicator.tsx 去 pill 背景改 `TPS {n}t/s` 纯文字（色档 27/53/80 未动）；AppShell.tsx 移动端 head 栏 TpsIndicator 与 SessionCostBadge 两行堆叠（h-[15px] 费用行 + h-[13px] TPS 行，36px 容器）；ActiveSession.tsx 移动头栏同口径。
- **验证**：desktop 3 文件 vitest 59/59。
- 注：本 commit 在 patch 最后重基（638c9bca，09-26 06:33）之后实施，当时 patch 未含其 delta——由下述 #90 重生成一并收编（8 文件）。

### 子优化（2026-09-26）：#90 思考过程 TPS 关联确认 + 显示格式（commit 7062daaa + 352e5241）

- **用户 verbatim（#90）**：「think思考过程的tps速率信息似乎还是没关联上。另外tps显示应该是"TPS XXt/s"最多四位数 TPS和数字之间应该有个间隔留白。」
- **关联确认（三层实证，结论=已关联且实时）**：
  ① 代码审计：thinking_delta→handler.ts 流式 `{type:'thinking',text}` 逐帧→chatStore `case 'thinking'`（skippedThinkingBlock=false 时）`getSessionTpsMeter().push(msg.text)`（491e2ca0 已提交）——thinking 是 decode 输出 token，与正文/工具入参同喂一个米表。
  ② WS 探针（bun 原生 WebSocket 直连 dev 7788）：thinking 100% 流式 delta（20-26ms 间隔），整块兜底（complete:true）未触发；用精确 TpsMeter 逻辑回放真实流，**thinking 相位实时 75-155 tps**（569 个 4Hz 采样点，avg≈100）。
  ③ H5 live 实测（agent-browser）：干净会话发「先认真思考再回答」→ 指示器 **HIDDEN→实时 46-116t/s 持续 24s**（两句话回答不可能流式 24s，即思考阶段），数字逐秒跳变。用户此前感知「没关联」=观察时会话正处回合间隙/已停，指示器显示的是**回合结束保持值**（0.5s 末段平均，如 100/1451t/s 恒定），非 thinking 实时值。
- **格式修复 2 项**：
  - **7062daaa**：vertical 分支（移动端两行）`TPS{n}t/s`→`TPS {n}t/s` 补留白（桌面分支 966ca8f1 已带空格，移动端漏了）——两端统一 "TPS XXXt/s"。
  - **352e5241**：数值封顶 4 位 `formatTps`（`Math.min(round, 9999)`）——聚合子代理/移动批量突发可超 4 位（实测保持值 1451），封顶防撑破固定栏宽；新增封顶单测。
- **验证**：TpsIndicator.test 4/4（含新封顶用例）；desktop tsc -b exit 0；前端全量 vitest 6228 pass（1 fail=MessageList 虚拟化用例 5s 超时，隔离单跑 201/201 过=负载 flaky 非回归）；src/server scrub env 3442/0。
- **Patch 重生成**：`tps-indicator.patch` **8 文件 839 行**（收编 966ca8f1 的 AppShell.tsx/ActiveSession.tsx 两行堆叠 delta + #90 格式/封顶 delta；此前 patch 停在 638c9bca 态缺这两块）。21 链（068b3ebd 基线顺序 apply 全 patch）FAIL=0，8 章文件逐字节=工作树，树级 delta 仅已知非章 WIP（#83 测试修复族 + #85 WIP + bun.lock/TerminalSettings/providerModels 3 项既有）。

> 注：上下文面板「生成速度」口径修正（decode-only，分母用 `totalDecodeDuration` 而非 `totalAPIDuration`）归**第七章**（cache-billing.patch），见该章。

### 子优化（2026-09-27）：费用/TPS **保持两行**，TPS 第二行改居中（patch `tps-centered-second-line.patch` #32）

**用户指示（verbatim）**

> 不对啊，我说的是TPS和费用信息成上下两行。然后费用信息显示出来占用的宽度很充足，处于其下方的TPS应该与上方的费用信息显示对仗工整。当前是在第二行且右靠齐，应该改为两行，TPS在第二行呈居中显示，这样显示更对仗工整。

- **布局保持两行不变**（#90/966ca8f1 引入的「上=费用、下=TPS」`flex-col` 双行结构**保留**），只改**水平对齐**：
  - 桌面 `ActiveSession.tsx`：外层 `flex h-[42px] shrink-0 flex-col **items-center** justify-center gap-0.5`（原 `items-end`）
  - H5 `AppShell.tsx`：外层 `flex h-[36px] shrink-0 flex-col **items-center** justify-center gap-0.5`（原 `items-end`），`<TpsIndicator vertical />` **保留**
- **原理**：外层宽度由最宽子项（费用徽章）决定；`items-center` 使较窄的 TPS 行**在费用徽章正下方水平居中**，两行宽度不对等时方才对仗工整（原先靠右对齐，视觉重心偏右）。
- **踩坑（本轮走过的弯路，记录以免重犯）**：曾一度把两行**改成单行并排**（并在 `TpsIndicator` 删掉 `vertical` 分支），属**理解错需求**——用户要的是「两行 + 居中」，不是「合并成一行」。已回退：`TpsIndicator.tsx` 恢复原样（`vertical` 分支保留），故该文件**不在本 patch 内**。
- **验证**：`TpsIndicator`(4) + `AppShell` + `ActiveSession`(34) 三文件 vitest **60/60 全绿**；35 链中该 patch 2 文件与工作树**逐字节一致**。

## 五、文件下载桥接功能（源§十二，✅ 2026-09-24）

### 需求背景

H5 浏览器端打开文件链接时，`/local-file/<absPath>` 直接内联显示而非触发下载，需要 `Content-Disposition: attachment` 头让 H5 真正下载文件；会话导出的文件列表卡（DownloadReferencesCard）需要展示文件名/大小/下载按钮，大小走批量 `/local-file/info` 端点一次拿全。

### 0.6.6 现状核对

- 服务端 `localFile.ts` 只有 `?download=1`/`?info=1` 未实现，`/local-file/` 走 `serveFileWithRange` 内联返回；`previewFs.ts` 有 `downloadHeadersFor()`（RFC5987 attachment 头）与 `servePreviewFsFile(download=false)` 参数预留，但路由没读 query 没传参。
- 前端无 `DownloadReferencesCard` / `fileSizeCache` / `downloadFileMeta`（三者均老 fork 独有，0.6.6 全缺）；`localFileUrl` 已在 `handlePreviewLink.ts:44-51`。
- 老 fork 完整实现=4 块：①localFile.ts `?info=1`/`?download=1` 分支 + `handleBatchLocalFileInfo`（POST `/local-file/info`）；②previewFs.ts 路由读 `?download=1` 传 `servePreviewFsFile`；③`DownloadReferencesCard.tsx`（收集 turn 内 Read 调用，`localFileUrl+?download=1`）；④`fileSizeCache.ts`（hot 50/120s→cold 150/30min，localStorage 持久化）+ `downloadFileMeta.ts`（fileTypeIcon/formatFileSize）。

### 实施方案（12 文件，3 新文件）

- **`src/server/api/localFile.ts`**：`?info=1`→JSON `{name,size,mime}`（`Bun.file().stat()`，不读内容）；`?download=1`→`serveFileWithRange(...,downloadHeadersFor())` 加 RFC5987 attachment 头（unicode/空格文件名正确）；`handleBatchLocalFileInfo(body)`：批量 stat，逐 path 走 `$HOME` sandbox，失败的静默跳过，返回 `{files:{path:{name,size,mime}}}`。
- **`src/server/index.ts`**：`POST /local-file/info` 路由插在 `/local-file/` 前缀分支**之前**（`/local-file/info` 也匹配该前缀，顺序敏感）。
- **`src/server/api/previewFs.ts`**：`handlePreviewFs` 读 `?download=1` 传 `servePreviewFsFile`；`servePreviewFsFile` 加 `download` 参数——download 时跳过 HTML base-rewrite 变换直接流式 + attachment 头（浏览器要原始字节非预览变换版）。
- **前端 3 新文件**：`fileSizeCache.ts`（两级 LRU，hot 50/120s + cold 150/30min，LRU 淘汰，localStorage `cc-haha:file-sizes` 持久化，`__clearFileSizeCache` 测试用）；`downloadFileMeta.ts`（fileTypeIcon 按扩展名映射 Material Symbols 图标 + formatFileSize 自适应单位）；`DownloadReferencesCard.tsx`（`TurnDownloadCard` 收集 turn 内 Read 调用的 `file_path`，去重；默认折叠不请求，展开时批量 `POST /local-file/info` 拿缺失大小并写入两级缓存；20 条分页 + "显示更多" + "显示全部"；下载链接=`localFileUrl+?download=1`）。
- **`ToolCallGroup.tsx` 接入**：import `TurnDownloadCard`；memory 分支（`MemoryToolActivityGroup` 后）与常规 return（`ToolCallGroupContent` 后）各插一处 `<TurnDownloadCard toolCalls={...} />`。
- i18n：`chat.downloadableFiles`/`chat.downloadableMore`/`chat.downloadableAll`/`workspace.download` 5 语言，插在 `chat.tpsSpeedTitle` 行后。

### 补全：文件浏览下载入口 + H5 内置浏览器提示（2026-09-25）

初版只做了「会话内 Read 文件下载卡」，文件浏览（工作区文件树 / open-with 菜单）里仍只能「添加到对话」不能下载，且 H5 点「应用内浏览器」无提示。本次补 3 项（复用既有 `?download=1` 端点与已有 i18n 键 `workspace.download`/`workspace.browser.unavailableTitle`，零新 i18n 键）：

- **A 文件树右键加「下载」**：`WorkspaceFileTreePane.tsx` 右键菜单「添加到对话」后加下载按钮（仅非目录行，`data-testid="workspace-tree-download"`），`resolveAbsoluteOpenPath(path, workDir)`（`systemFileOpen.ts:24`，path 已绝对/无 workDir 原样返回，否则 join）解析绝对路径后调共享下载入口。
- **B open-with 菜单加「下载」**：`openWithItems.ts` `OpenWithIcon` 联合加 `'download'`、`OpenWithDeps` 加 `downloadFile?`、`buildOpenWithItems` 在 clipboard 组（copy 之后）推 `id:'download'` 行（label 复用 `workspace.download`）；`openWithMenuItems.ts` 绑定 `downloadFile=(p)=>downloadLocalFile(p)`（file context 块）；`OpenWithMenu.tsx` `ItemIcon` 加 `download`→lucide `Download` 图标分支；`WorkspaceFileOpenWith.tsx` 的 `filter` 放行 `item.id==='download'`。
- **C H5 内置浏览器提示**：`openWithMenuItems.ts` `openInAppBrowser` 改——`!isWorkspaceBrowserAvailable()`（`workspace/browserHost.ts:37`）时 `addToast({type:'info', message:t('workspace.browser.unavailableTitle')})`（=「内置浏览器需要桌面版」）+ `window.open(url,'_blank','noopener,noreferrer')` 兜底，桌面版仍走 `workspaceOpen.browser`。
- **共享下载入口**：`handlePreviewLink.ts` 新增 `export downloadLocalFile(absolutePath)`——临时 `<a href=localFileUrl(serverBase,absPath)?download=1 rel=noopener>` appendChild+click+remove（anchor 法而非 fetch：二进制直下 + 服务端 RFC5987 attachment 头定保存名，无需缓冲整文件或猜 MIME）。

### 验证

- `desktop tsc -b` exit 0；6 受影响测试文件 **149/149**（openWithItems 54/handlePreviewLink 34/OpenWithMenu 17/openWithMenuItems 3/WorkspaceFileOpenWith 10/WorkspaceFileTreePane 31）；全量前端 vitest **12300 pass / 12 skip / 0 fail**（零回归，对齐基线）。
- `vite build` 成功，新 bundle `App-48eEOxTf.js`。
- **live 7788 H5 全确认**：A 文件树右键含「添加到对话/下载」；B 文件 tab 右上角 split-button open-with 下拉含「…复制文件内容/下载/刷新工作区」；C open-with 点「应用内浏览器」→ toast「内置浏览器需要桌面版」+ 系统浏览器打开。
- **坑（.js 孪生）**：仓内每个 `.ts/.tsx` 有一个 untracked 的 `.js` 孪生（tsc emit 风格，批量生成），Vite 默认 `resolve.extensions` 把 `.js` 排在 `.tsx` 前 → `vite build` 实际 bundle 旧的 `.js` 而非改过的 `.tsx`（症状=新 testid/字符串在 dist/ grep 0 命中）。修法=`tsc -p tsconfig.json --noEmit false` 同步全部 `.js`（TS5096 allowImportingTsExtensions 报错不阻断 emit）→ 清 `dist`+`node_modules/.vite` → `vite build`。`tsc -b`（noEmit:true）不生成孪生。`.js` 全 untracked 不入 git/patch。
- **权威零回归（初版）**：全量 `src/server` bun test junit 比对基线 worktree（2f8d819d）——新增 1 条 `diagnostics API`，单独跑 3 次（当前树+基线各 37/37 全绿）确认负载 flaky，非引入。
- 坑（初版）：`previewFs.ts` 0.6.6 缺 `downloadHeadersFor` 定义（仅老 fork 有）→ import 时报 `Export named 'downloadHeadersFor' not found`，需从老 fork 移植到 `serveFileWithRange` 后。
- Patch：`modify/patches/file-download.patch`（**20 文件 951 行**，含 3 前端新文件 mode 100644 + 6 文件浏览下载入口文件；2026-09-26 因第四章子代理汇聚新增 i18n 键而连锁重生成）。**19 patch 全链 `git apply` 干净且逐字节等于工作树（仅 5 已知非章 delta）**。

---

## 六、设置-关于-更新：禁止更新开关（源§十三，✅ 2026-09-25）

### 需求背景

源§十三：桌面端 设置→关于→更新 区域加「禁止更新」开关，彻底关闭自动更新检查与下载（0.5.x 现状：启动即 `checkForUpdates({silent:true,autoDownload:true})` 检查+自动下载，AboutSettings 仅手动检查按钮，无开关）。

**语义决策（用户拍板）= 完全禁用（含手动）**：启动检查跳过 + 手动「检查更新」按钮置灰。`checkForUpdates` 外部调用方仅 AboutSettings 按钮一处，守卫放在 store 层即可全覆盖。

### 0.6.6 现状核对

- 更新系统：`UpdateChecker.tsx` 挂载即 `useUpdateStore.initialize()`；`updateStore.initialize()` 延迟 5s 后 `checkForUpdates({silent:true})`（startupCheckPromise 单飞）；`checkForUpdates({silent,autoDownload})` 内 `autoDownload && (shouldOffer||!silent)` 触发 `downloadUpdate()`。
- 设置持久化=REST `/api/settings/user`，服务端 `settingsService.updateUserSettings` 顶层浅合并（`Object.assign`）→ **新 boolean 字段服务端零改动**（照 `autoDreamEnabled` 完整 boolean toggle 范式）。
- **坑（live 发现）**：H5 浏览器端（`remoteBrowser=true`，由 `classifyH5Request==='h5-browser'` 判定）走 `router.ts:68 validateRemoteSettingsPatch`（`WRITE_SETTINGS` 白名单）与 `:93 projectRemoteSettings`（`READ_SETTINGS` 投影）——新 key 两侧都不在名单 → PUT 400「Unsupported General setting」+ 乐观更新回弹、GET 读回永远 false。loopback 桌面直连不走此路径（loopback curl 200），所以单测全绿仍会漏。

### 实施方案

1. `desktop/src/types/settings.ts`：`UserSettings` 加 `disableUpdates?: boolean`（webSearch 与 updateProxy 之间）。
2. `desktop/src/stores/settingsStore.ts`：`disableUpdates: boolean` 字段（初始 false）+ hydrate `userSettings.disableUpdates === true` + `setDisableUpdates(enabled)` 乐观 set→`settingsApi.updateUser`→失败回滚 throw（照 `setAutoDreamEnabled`）。
3. `desktop/src/stores/updateStore.ts` 两处守卫：`initialize()` 在 `getUpdateHost()` 后、`checkForUpdates()` 在 host 判定后各加 `if (useSettingsStore.getState().disableUpdates) return (null)`——启动/手动检查全拦，自动下载随检查入口一并停。
4. `desktop/src/pages/settings/AboutSettings.tsx`：Check now 按钮 `disabled={disableUpdates}`；按钮块后插 `Switch`（label/description 走 i18n）——「关于」tab 桌面+H5 共用（H5Settings.tsx:92 已渲染 AboutSettings）。
5. **`src/server/remoteBrowserPolicy.ts`**：`disableUpdates` 加进 `READ_SETTINGS` 与 `WRITE_SETTINGS`（boolean 走默认 `typeof value==='boolean'` 校验）——H5 手机可读写该开关（同 `skipAutoPermissionPrompt` 先例）。
6. i18n `update.disableUpdates`/`update.disableUpdatesDescription` 5 语言（en/zh/zh-TW/jp/kr，插在 `update.failed` 后）。
7. 测试：`updateStore.test.ts` +2（disableUpdates 时手动 check 返回 null 且不触发 check；initialize+fakeTimers 6s 启动检查不触发）；`remoteBrowserPolicy.test.ts` +3 断言（`validateRemoteSettingsPatch({disableUpdates:true})` true、非 boolean false、`projectRemoteSettings` 透传）。

### 验证

- 桌面 `tsc -b` exit 0；`updateStore.test.ts` 20/20；全量前端 vitest **6143 pass/2 fail**（2 条=基线既有 providerModels、MessagePayloadRetention，零回归）；`remoteBrowserPolicy`+`router.remoteBrowser` 10/10。
- vite build → App-BxBY2ThW.js；dev 7788 live（H5 关于页）：开关开→persisted=true+「检查更新」置灰、关→persisted=false+恢复，console 无错（400 修复前开关回弹）。
- **坑实录**：初版漏改 `remoteBrowserPolicy.ts` → H5 PUT 400、开关回弹（loopback curl 200 未暴露）；补 READ+WRITE 白名单后 H5 读写全通。
- Patch：`modify/patches/disable-updates.patch`（12 文件 302 行）。**9 patch 全链 `git apply` 干净且 disable-updates 12 文件逐字节等于工作树（0 差异）**。

---

## 七、上下文缓存与计费显示（源§十四，✅ 2026-09-25）

### 需求背景

旧 fork 的「缓存命中率」读数用的是**全会话累计口径**（`cacheRead / 全会话 prompt`）。长 agent 会话里每轮都会重放前文 prompt，累计比值被历史轮稀释到 ~0.5%，用户看到的命中率与当前缓存实际表现严重不符。本项要做两件事：

1. **缓存命中率口径修正**：从「会话累计」改为**请求级最新轮** `cacheRead / (input + cacheRead + cacheWrite)`——即「本轮提示词里有多少来自缓存」，实测 99.798%，才反映缓存的真实逐轮表现。
2. **会话总费用显示**：在会话 header 上展示会话累计费用，USD + CNY 双显示。

用户拍板（AskUserQuestion）：显示位置「三处全做（header 费用徽标 + 上下文指示器缓存尾巴 + 上下文面板详情行），但根据当前新源码重新制定更优雅的融合效果，老优化项的显示方式不需要完全遵守」；货币口径「USD/CNY 双显示，CNY = USD × 7.2 固定汇率（仅展示，非计费换算）」。

### 0.6.6 现状核对

- **数据全部现成，无需新端点**：
  - `desktop/src/api/sessions.ts:187-222` `SessionUsageSnapshot` 已带 `totalCostUSD` / `costDisplay`（会话累计，服务端预格式化）。
  - `desktop/src/api/sessions.ts:270-275` `SessionContextSnapshot.apiUsage = {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens} | null`（最新一轮请求级用量，live 路径也回填；`input_tokens` 已是纯 fresh 语义）。
  - `getSessionUsage(sessionId, signal)` → `GET /api/sessions/{id}/inspection?includeContext=0&usageOnly=1`（单 CLI control，廉价，可轮询）。
- `desktop/src/lib/sessionUsageMetrics.ts` 已有 `deriveSessionUsageMetrics`（含会话累计 `cacheHitRate`）/ `formatCacheHitRate`，但无请求级命中率、无 CNY 格式化。
- 三处展示位：上下文指示器 `ContextUsageIndicator.tsx`（含详情 `ContextUsageDetails.tsx`）、上下文概览 `LocalSlashCommandPanel.tsx` 的 `ContextOverview`、会话 header（桌面 `pages/ActiveSession.tsx` + 移动 `components/layout/AppShell.tsx`）。

### 实施方案

1. **`sessionUsageMetrics.ts`**：新增 `latestTurnCacheHitRate({input_tokens, cache_creation_input_tokens, cache_read_input_tokens}): number|null`（`promptTokens = input+cacheRead+cacheWrite`，`=0` 返回 null）——请求级命中率的核心；新增 `CNY_PER_USD = 7.2` 与 `formatCnyCost(usd)`（`¥`，>0.5 两位小数、否则四位，与 USD 同精度对齐）、`formatCompactTokens`（`1.2M/375K/812`）。
2. **`ContextUsageDetails.tsx`**：`ContextUsageSessionStats` 增 `cacheReadTokens` + `totalCostUSD`；`SessionStatGrid` 缓存命中行 rate 非 null 时橙色 `#ea580c` + 行内 compact tokens；费用行旁增 `· ¥…` CNY span。
3. **`ContextUsageIndicator.tsx`**：`latestTurnUsage = displayContext?.apiUsage ?? null`，派生 `latestCacheRate` / `latestCacheReadTokens`；触发容器改 `relative flex`，环形按钮旁增兄弟节点缓存命中尾巴 `data-testid="context-cache-hit-tail"`（`#ea580c` 10px，无数据不显示，title 走 `contextIndicator.cacheHint`）；详情面板 `sessionStats` 以最新轮命中率为首、回退会话累计。
4. **`LocalSlashCommandPanel.tsx`**：`ContextOverview` 头部用量行增 `98% cached`（`#ea580c`）；第 4 个 pill 在有 cache 时换为 cache 命中行（`formatCacheHitRate` + compact tokens 明细），否则保留原 context pill。
5. **`SessionCostBadge.tsx`（新增）**：会话 header 费用徽标。挂载读一次 `getSessionUsage`（`usageOnly` 廉价路径），`produced=0`（无 input+output+cache tokens）不显示（避免首轮前 `$0.0000` 读成测量值）；`active` 时 `setInterval` 10s 轮询（cost 只在 turn 完成时变，但 turn 可跑数分钟），`inFlight` 防堆叠；pill 双币（compact 移动端仅 USD），`data-testid="session-cost-badge"`。
6. **挂载**：桌面 `pages/ActiveSession.tsx` 会话 header actions 区（TpsIndicator 与刷新按钮之间，`active={chatState!=='idle'}`）；移动 `components/layout/AppShell.tsx` 移动 header（TpsIndicator vertical 后，`active={activeTab?.status==='running'}` + `compact`）。
7. **i18n（5 语言）**：各增 `slash.inspector.context.cache` / `.cached`、`contextIndicator.cacheHint`（`{percent}` `{tokens}`）、`session.totalCost` 共 4 key。

### 验证

- 桌面 `tsc -b` exit 0；受影响 4 测试文件 **84/84**（ContextUsageIndicator 27 / LocalSlashCommandPanel 3 / AppShell 22 / ActiveSession 32）；全量前端 vitest **6143 pass/2 fail**（2 条=基线既有 providerModels、MessagePayloadRetention，零回归）。
- vite build → App-C54fEqkT.js（2200.13 kB，2.66s）。
- **dev 7788 live（127.0.0.1 agent-browser 进会话）**：header 费用徽标 `$0.87 · ¥6.27`（USD+CNY 双显示）+ 上下文指示器缓存尾巴 `96.7%`（`apiUsage` 有值时；estimate 路径 `apiUsage=undefined` 时尾巴隐藏、徽标仍显示 totalCost），console 无错。
- **布局微调**（2026-09-25 追加，live 双端像素级验证）：缓存百分比尾巴相对触发**按钮**定位——桌面 32px 按钮/20px 可见圆环（6px padding）、移动 44px 触摸目标/22px 圆环（11px padding），同一 translate 值被移动端多出的 5px padding 吞掉（表现为"左挪无效"）。终值：尾巴 `transform: isMobileBrowser ? 'translate(-9px, 3px)' : 'translate(-4px, 3px)'`（两端均达「距可见圆环 2px + 下移 3px」）；整组（环+百分比）外层容器 `transform: translateX(15px)`（composer 工具栏右对齐，用 transform 而非 margin——首子项 margin-left 只加空 flex-1 间隙不挪元素；15px 使尾巴右缘与右侧 check 图标留 4.5px，不再贴死）。
- **上下文浮动卡片微调**（2026-09-25 追加，live 1920 宽桌面浏览器逐像素验证）：
  ①桌面 popover 卡（POPOVER_WIDTH=**384**，原 340；加宽以容纳 6 位数费用+等距排布，用户拍板）整体**左移 30px**——`updatePopoverPosition` 加 `LEFT_NUDGE_PX=30`（初版 50px 偏多改 30，live 复测 gapRingToCardRight=30）；
  ②三字段（生成速度/缓存命中/会话费用）**间距匀称**：`SessionStatGrid` 由固定列宽 grid 改 **flex + `justify-evenly` + 每组 `flex-col items-center`**——字段组按内容取宽，浏览器把剩余宽度均分成相等的缝与两端留白，idle 短值（`--`）不再留死列、长值（6 位数费用）缝自动收缩，任意取值下三组间距一致（live 实测中间两缝=**31px 相等**、两端各 32px）；三值统一 `text-[13px]`/次级 `text-[10px]`、`whitespace-nowrap` 不折行，双币/百分比间 `·` 分隔（与 title tooltip 一致）；
  ③popover 容器右 padding 22→18px（`px-[18px]`）；
  ④**6 位数费用容纳**：`$123.45 · ¥888.84`@13/10px=111px，flex 下缝自动收缩实测不溢出（live 注入验证）；8 位极端 `$9999.99 · ¥71999.93`=130px 缝收窄后仍可容纳。
  迭代史：等宽 3 列 → 费用撑破 → `1fr_1fr_1.6fr`+transform 20px 右移 → 标签不对齐被否 → 内容定列宽 11:12:14+18px padding → 用户指出「中间两个间隔一宽一窄」（左窄列短值留 77px 死空，右缝仅 29px）→ 终值=**flex justify-evenly 等距**（治本，间距不再依赖列宽猜测）+ 384px 卡 + 13/10 统一字号 + 18px padding。
- **第五章下载功能回归测试补齐**（随本次一并提交）：`6c7d4a62` 加下载项时漏改 3 处既有断言——WorkspaceFileOpenWith.test 菜单项数 4→5 + mock capabilities 补 `workspaceBrowser: true`（桌面宿主真实值，electronHost.ts:79，缺它则内置浏览器走 H5 兜底路径，2 条断言连带挂）；WorkspaceFileTreePane.test 键盘用例 `getByRole('menuitem')` 因新增下载项多匹配，加 `name: 'Add to chat'` 限定。全量 vitest 12298 pass / 2 fail=仅 MessageList 虚拟化用例负载 flaky（独立跑 198/198）。

### 子优化（2026-09-25）：上下文面板「生成速度」口径修正（decode-only）

- **根因**：`sessionUsageMetrics.ts` 的 `deriveSessionUsageMetrics` 原来用 `totalAPIDuration`（= 解码时长 + TTFT 首 token 等待）作分母算 `tokensPerSecond`，把首 token 等待混入「生成时间」→ 上下文面板「生成速度」实测偏低 ~24%（46.2 vs 真实 61.0）。
- **修正**：分母改用 `totalDecodeDuration`（纯解码时长），`decodeMs > 0` 时优先；否则回退 `totalAPIDuration`。`generationMs = decodeMs > 0 ? decodeMs : apiMs`；`tokensPerSecond = generationMs > 0 && output > 0 ? output / (generationMs/1000) : null`。
- **测试**：`sessionUsageMetrics.test.ts` 3 处更新（500=1000/2s；回退 API=200；双 0→null；长会话 166998/326）；`ContextUsageIndicator.test.tsx:894-895` 断言 57→200（2400/12s decode）。
- **live 7788 确认**：上下文面板「生成速度」= `61tok/s`（改前 46.2；会话 f1be2b52 数据 totalAPIDuration=66971/totalDecodeDuration=50702/totalTtftDuration=16243/output=3095）。
- 验证：tsc -b exit 0；5 受影响文件 107/107；全量前端 vitest 6144/2（既有）；vite build `App-CJApNwcB.js`。
- **Patch**：`modify/patches/cache-billing.patch`（14 文件 650 行，含本口径修正 2 测试文件）。**10 patch 全链 `git apply` 干净且 cache-billing 14 文件逐字节等于工作树（0 差异）**。

---

## 八、思考模式二级开关：think 是否回传后端 API（源§二十五，✅ 2026-09-26）

### 需求背景

CC-HAHA 默认把上一轮 thinking 全文发回后端（Anthropic 格式原样透传，且 1P/Bedrock/Vertex 还发 `context_management clear_thinking keep:'all'` 显式要求服务端保留）。对自建 vLLM（无 1P 缓存保留机制）= 每轮实打实的额外 prefill token 开销。本项在「设置-通用-思考模式」下新增**二级开关**「将思考内容回传后端 API」：

- **关（默认/缺省）**：构造 API 请求体时剥离上轮 assistant 的 `thinking` / `redacted_thinking` block，不再作为上下文发给后端。
- **开（`sendThinkingHistory=true`）**：维持原行为（thinking 原样随 messages 回传）。
- **本地留存不变**：无论开关状态，本地会话历史（内存滚动 / jsonl 落盘 / 会话内回看渲染）完整保留 thinking。

设计意图：**升级后默认行为翻转**（thinking 不再回传省 token）。若发现模型质量回退，设置页打开二级开关或 `CC_HAHA_SEND_THINKING_HISTORY=1` 即恢复。

### 0.6.6 现状核对

- settings schema：`src/utils/settings/types.ts` 顶层 `.passthrough()`(:1174) 但文件校验 `.strict()`(:193) → 新字段须进 schema，否则被 strip 掉。范式 `alwaysThinkingEnabled`(:746-752)。
- thinking 工具：`src/utils/thinking.ts`（env 先例 `shouldSendExplicitDisabledThinking():220-222`）；`getSettingsWithErrors()` 已 import(:8)，返回 `{settings, errors}`。
- 主 API 咽喉点：`src/utils/messages.ts:2022` `normalizeMessagesForAPI(messages, tools, currentModel)`（3 参），尾部清理链 :2393-2472。`isThinkingBlock`:5026（匹配 `thinking`/`redacted_thinking`）；`stripSignatureBlocks`:5321 成熟模式可复用。
- 主路径挂载：`src/services/api/claude.ts:1417` 调用 + `getAPIContextManagement`:1837（局部 `hasThinking`:1721 另用于 temperature）。
- OpenAI 路线：`src/server/proxy/handler.ts:706` `roundTripReasoningContent`（DeepSeek/opencode.ai 明文回传）；`src/services/openaiAuth/fetch.ts:225` 响应方向 `preserveOpenAIReasoning`（请求方向 :61 保持 `true`）。
- **与老 fork 差异**：0.6.6 `normalizeMessagesForAPI` 是 **3 参**（本次加 options 成第 4 参）。0.6.6 有 `remoteBrowserPolicy.ts` 白名单（老 fork 无），新字段须同步 READ/WRITE 否则 H5 PUT 400 + 开关回弹（第六章坑）。0.6.6 `providers.test.ts` 有 2 个断言 DeepSeek `reasoning_content` 回传的用例（老 fork 无），门控默认关会让它们回归。

### 实施方案

1. **`src/utils/settings/types.ts`**：`alwaysThinkingEnabled` 后加 `sendThinkingHistory: z.boolean().optional().describe(...)`（缺省/absent=false=不回传）。
2. **`src/utils/thinking.ts`**：新增 `shouldSendThinkingToAPI(): boolean`——env `CC_HAHA_SEND_THINKING_HISTORY` 强开（`isEnvTruthy`，调试逃生门）→ `getSettingsWithErrors().settings.sendThinkingHistory === true`。
3. **`src/utils/messages.ts`**：`normalizeMessagesForAPI` 加第 4 参 `options?: { stripThinking?: boolean }`；在尾部清理链 `relocated` 之后、`filterOrphanedThinkingOnlyMessages` 之前插入 `withStrippedThinking = options?.stripThinking ? stripThinkingBlocksForAPI(relocated) : relocated`（顺序约束：thinking-only 剥空由 `ensureNonEmptyAssistantContent` 占位兜底，API 400 不变式全保持）。新增 `stripThinkingBlocksForAPI`——map assistant 消息 `content.filter(block => !isThinkingBlock(block))`，复用 `stripSignatureBlocks` 模式。其余旁路调用方（token 估算/compact 等）不传参 → **零行为变化**。
4. **`src/services/api/claude.ts`**：:1417 调用加第 4 参 `{ stripThinking: !shouldSendThinkingToAPI() }`（desktop/CLI/SDK 唯一 API 咽喉点）；`getAPIContextManagement` 改 `hasThinking: hasThinking && shouldSendThinkingToAPI()`（开关关时不发无意义的 `clear_thinking keep:'all'`；局部 `hasThinking` 仍用于 temperature 等）。
5. **`src/services/openaiAuth/fetch.ts`**：仅**响应方向** :225 `preserveOpenAIReasoning: shouldSendThinkingToAPI()`（**请求方向 :61 保持 `true`**，忠实老 fork）。
6. **`src/server/proxy/handler.ts`**：:706 `roundTripReasoningContent: (knownDeepSeekHost || reasoningProfile?.family === 'deepseek-v4') && shouldSendThinkingToAPI()`（其余 Chat 兼容商本就丢弃，不变）。
7. **`src/tools/ConfigTool/supportedSettings.ts`**：白名单加 `sendThinkingHistory`（`{source:'settings',type:'boolean',description:...}`，无 appStateKey）。
8. **`src/server/remoteBrowserPolicy.ts`**（0.6.6 特有）：`sendThinkingHistory` 加进 `READ_SETTINGS` 与 `WRITE_SETTINGS`（boolean 走默认校验）——H5 手机可读写（第六章坑）。
9. **桌面端**：`desktop/src/types/settings.ts` 加 `sendThinkingHistory?: boolean`；`settingsStore.ts` 加 `thinkingSendBack`（默认 false、读 `=== true`、setter 乐观 set→`updateUser({sendThinkingHistory})`→catch 回滚）；`GeneralSettings.tsx` 思考卡片主 checkbox 后插二级 checkbox（`thinkingEnabled &&` 门控）。
10. **i18n（5 语言）**：`settings.general.thinkingSendBackTitle` / `thinkingSendBackHint` 各 2 条（en/zh/zh-TW/jp/kr，插在 `thinkingHint` 后）。
11. **测试**：`thinking.test.ts` +4（`mock.module('../settings/settings.js')` 范式；absent=false / false=false / true=true / env 强开覆盖 false setting）；`messages.test.ts` +3（默认保留 / 剥离 thinking+redacted 且 text、tool_use 保留 / thinking-only 消息无错，**4 参调用** `(...,[],undefined,{stripThinking:true})`）；`providers.test.ts` 2 个 DeepSeek round-trip 用例内显式 `CC_HAHA_SEND_THINKING_HISTORY=1`（门控默认关会让它们回归，测试本意=验证 round-trip 路径）。

### 验证

- **server 全量零回归**：全量 `src/server` **3330 pass / 22 fail**，22 条失败名单与基线 worktree 逐条一致（含 2 条 DeepSeek round-trip 回归修好后）。`thinking.test.ts`+`messages.test.ts` 新增 7 用例全过（`thinking.test.ts` 既有 1 条 `shouldIncludeFirstPartyOnlyBetas` 环境依赖失败=基线既有，非本章引入）；`providers.test.ts` 142/142。
- **桌面**：`tsc -b` exit 0；`H5Settings`+`SettingsOutputStyle` 10/10；全量前端 vitest **6146 pass / 0 fail**（1df6bf70 修复后基线，零回归）。
- vite build → `App-Cl3KkIFE.js`（2201.04 kB，2.71s）。
- **行为矩阵**（对齐源§二十五）：Anthropic 关=剥离 + `clear_thinking` 不发 / 开=原样 + `keep:'all'`；OpenAI Chat DeepSeek 关=不发 `reasoning_content` / 开=发明文；Codex OAuth 关=不发加密信封 / 开=发；其余商本就丢弃；本地历史始终完整保留。
- **热更新**：开关在每次 API 请求时经 `getSettingsWithErrors` 读取（changeDetector 文件监听 + resetSettingsCache 既有机制），改完即对下一次请求生效，无需推控制消息。
- **Patch**：`modify/patches/thinking-switch.patch`（19 文件 619 行，含 3 测试文件）。**11 patch 全链 `git apply` 干净（仅 h5-settings-parity 既有 EOF 空白 warning）且 thinking-switch 19 文件逐字节等于工作树（0 差异）**。

---

## 九、H5 设置页与桌面端全 tab 对齐（放开浏览器「两 pill」围栏）（✅ 2026-09-24）

### 需求背景

0.6.6 的浏览器/H5 端设置页被「围栏」限制：`desktop/src/pages/Settings.tsx:28-30` 依据 `getDesktopHost().isDesktop` 分流，浏览器只渲染 `H5Settings`，而 `H5Settings.tsx` 原本只放 **2 个 pill**（模型配置 providers + 通用 general）。桌面端 `DesktopSettings` 则有 15 个主 tab + about 独立分组（共 16 个设置项）。用户要求 H5 在手机浏览器上能像桌面端一样**看到并使用全部设置项**（含通用 tab 换桌面完整版 GeneralSettings，接受浏览器端设置写回主机）。

### 0.6.6 现状核对

- 分流点：`Settings.tsx:29` `getDesktopHost().isDesktop ? <DesktopSettings/> : <H5Settings/>`（**不改**，H5 入口仍是 H5Settings）。
- `DesktopSettings`（`Settings.tsx:32-112`）：195px 侧栏 `TabButton` 列表 `:69-87`（15 主 + about 独立分组），内容 switch `:92-107`。
- 各 tab 组件浏览器安全性（Explore 审查结论）：多数自带 `getDesktopHost()` capabilities 降级——
  - Terminal：浏览器 `terminalApi.isAvailable()`(=`capabilities.terminal`)=false → 显示「需桌面端」EmptyState（`TerminalSettings.tsx:712`）。
  - Pet / ComputerUse / About：各自 `isDesktop`/capabilities 降级。
  - DirectoryPicker（Adapter/Mcp/Agent 共用）：浏览器走 `filesystemApi.browse` 浏览模式。
  - General：`setTheme` 只写 uiStore 不写回主机；dialogs/appMode/notifications 三处桌面 host 调用均有 capability 或 desktop-only 渲染守卫。
  - 数据全部走 `/api`（H5 可达）。
- `SettingsTab` union 已含 16 值（`uiStore.ts:233-249`）；`SettingsPill` 自带 `aria-pressed` + 渲染 `<button>`（`SettingsSection.tsx:101-129`）；i18n `settings.tab.*` 全部已存在。

### 实施方案

1. **提取 tab 常量供两端复用**（`Settings.tsx`）：新增模块级 `export const SETTINGS_TABS`（15 项 `{id, icon}` 数组，顺序与桌面 rail 一致）+ `export const SETTINGS_ABOUT_TAB = { id:'about', icon:'info' }`；`DesktopSettings` 侧栏改为遍历 `SETTINGS_TABS.map(...)`，about 独立分组保持不变。
2. **重写 `H5Settings.tsx`** 暴露与桌面端完全一致的 16 项（15 主 + about）：
   - `selected = pending ?? active`，pending 消费 effect（`setActiveSettingsTab(pending)` + `setPendingSettingsTab(null)`）。
   - 导航改为**横向可滚动 pill 条**（`overflow-x-auto` + 隐藏滚动条），适配窄屏；选中 pill 自动 `scrollIntoView`。
   - 内容区 16 分支与 `DesktopSettings:92-107` 一致（trace 用 `overflow-hidden` 全宽容器特殊分支），providers 保留 `<ProviderSettings browserMode />`，general 用桌面完整版 `<GeneralSettings />`。
   - skills/plugins 用本地 `H5SkillSettings`/`H5PluginSettings` 包装（selected 详情模式，`SettingsPageHeader` + List），与桌面 rail 的 SkillSettings/PluginSettings 同构。
3. **删除** `H5GeneralSettings.tsx`（仅旧 H5Settings 引用，被桌面 GeneralSettings 取代）；保留 `h5Settings.*` i18n key 不动。
4. **重写 `H5Settings.test.tsx`**：13 个页面组件 `vi.mock`（工厂函数，导出名与真实模块导出名一致），8 个用例——pill 数断言 **16**（15 主 + about）、导航到 Terminal/H5Access、4 个 ProviderSettings browserMode 原用例保留、Settings 路由 16 pill + provider 渲染。

### 验证

- **单测**：`H5Settings.test.tsx` 8/8 pass；desktop 全量 vitest 6137 pass（2 个既有失败：`providerModels.test.ts` 分组顺序、`MessagePayloadRetention.test.tsx` 5s 超时，均非本次触及）；`tsc -b` 0 错误。
- **重 build + 重启 7788 dev**：`cd desktop && node ./node_modules/vite/bin/vite.js build` → 新 bundle `index-B_ViiZEH.js`（旧 `index-ZWgLHPz_.js`）；线上 App chunk 含新横向导航特征 class（`overflow-x-auto border-b`）2 处，确认新 H5 设置页已打包并伺服。
- **patch 干净应用**：`modify/patches/h5-settings-parity.patch`（4 文件）经 `git apply --check` 验证可干净应用于 v0.6.6 基线 2f8d819d。
- **待手机实测**：192.168.10.140 开 `http://192.168.10.43:7788` 确认 16 项可见可切换（含 H5 访问里的 requireToken 开关）。

### 9.x H5 设置项 400/403 修复（remoteBrowser 白名单对齐，✅ 2026-09-27）

**问题**：H5 放开全 tab 后，手机（LAN public 源）操作通用/网络等设置项大面积 400「Unsupported General setting」，部分子路由 403。loopback curl 全 200 不暴露——因为 `classifyH5Request`（`src/server/h5AccessPolicy.ts`）仅对 public 源（`h5-browser`）走 `validateRemoteSettingsPatch` 白名单（`src/server/router.ts:68`），loopback 属 local-trusted 直连 `handleUserSettings`（宽松，只查 JSON）。

**根因**：`remoteBrowserPolicy.ts` 的 `READ_SETTINGS`/`WRITE_SETTINGS` 白名单是 H5 设置放开前的小集合（10/8 key），而桌面完整版 `GeneralSettings` 经 settingsStore 会写 16 个字段，其中 8 个不在 WRITE 白名单：`agentTeamsEnabled`/`autoDreamEnabled`/`skipWebFetchPreflight`/`desktopNotificationsEnabled`（bool）、`cleanupPeriodDays`（number 0–3650）、`webSearch`/`updateProxy`/`network`（对象）。另 `/api/settings` 子路由（output-styles、output-style、session-cleanup）不在 `remoteSettingsRouteAllowed`；`session-cleanup` 还被 `LOCAL_CREDENTIAL_ONLY_PATHS` 拦（设计=只许本地桌面进程调，用户拍板移除以完全对齐桌面）。

**修复**（7 文件，全 src/server/）：
1. `remoteBrowserPolicy.ts`：READ/WRITE 白名单 +8；新增形状校验器 `isValidWebSearch`（mode∈auto/anthropic/tavily/brave/disabled + 可选 apiKey 字符串）、`isValidUpdateProxy`（mode∈system/manual + url）、`isValidNetwork`（aiRequestTimeoutMs 30s–2^31ms + proxy.mode∈direct/system/manual + url）、`isValidCleanupPeriodDays`（int 0..3650）；`projectRemoteSettings` 重写为按 READ_SETTINGS 循环投影，4 个对象/数值字段校验后深拷贝（防 H5 刷新后对象值丢失回弹）；`remoteSettingsRouteAllowed` 扩：settings/user GET/PUT + output-styles GET + output-style PUT + session-cleanup POST。
2. `router.ts`：字段白名单校验+GET 投影只 gate `/api/settings/user`（`parts[2]==='user'`），子路由 body 交 handler 自校验。
3. `h5AccessPolicy.ts`：`LOCAL_CREDENTIAL_ONLY_PATHS` 清空（保留 gate 机制与注释）。
4–7. 测试同步：`remoteBrowserPolicy.test.ts` +12 路由白名单断言；`router.remoteBrowser.test.ts` +子路由用例（200/403）；`h5-access-policy.test.ts` 反转 session-cleanup 断言（仍保留 /api/h5-access 本地限定）；`h5-access-auth.test.ts` preflight 403 列表去掉 session-cleanup。

**验证**：live 7788 LAN（192.168.10.43 + H5 token）——8 字段 PUT 全 200、GET/PUT output-style(s) 200、POST session-cleanup 200、错误方法 403、`/project`/`/cli-launcher`/`/permission-mode` 仍 403、GET /user 投影回读 6 新字段全在、坏形状（mode:'bogus'/3651/-1）仍 400；3 测试文件 13/13；`src/server` 全量零回归。

**patch**：`modify/patches/h5-settings-whitelist.patch`（7 文件 357 行，链位 12，基线 6d4fd126）。

---

## 十、本地开发模式注意事项（✅ 2026-09-24 跑通）

> 0.6.6 基座的本地开发模式（sidecar server 直接跑源码）已跑通，本节固化关键节点，避免遗失。
> 目的：开发模式与在用的桌面端（`/opt/Claude Code Haha`，端口 8877）完全隔离，互不干扰。

### 10.1 环境准备

- 依赖：仓库根 `bun install` + `cd desktop && bun install`（bun 位于 `~/.bun/bin/bun`）。
- H5 静态页：sidecar 从 `CLAUDE_H5_DIST_DIR`（或 cwd 下 `desktop/dist`）读静态资源，**必须先构建**：
  `cd desktop && bun run build`（含 preview-agent 构建 + tsc -b + vite build，产物在 `desktop/dist/`）。

### 10.2 数据/配置复制（与桌面端隔离）

- 数据根目录规则：`$CLAUDE_CONFIG_DIR/cc-haha/`（代码内 `path.join(configDir, 'cc-haha', ...)`，`configDir = process.env.CLAUDE_CONFIG_DIR || ~/.claude`）。
  - 桌面端在用：`~/.claude/cc-haha`（210M，db/ 占 209M：index-v1.sqlite 78M + search-index-v1.sqlite 110M 等）。
- 复制方法（dev 用独立副本）：
  ```bash
  mkdir -p /home/zeaxion/cc-haha-dev
  cp -a ~/.claude/cc-haha /home/zeaxion/cc-haha-dev/cc-haha
  ```
- dev 副本 `settings.json` 改 `h5Access.fixedPort: 8877 → 7788`（`publicBaseUrl` 保持 plain-lan `http://192.168.10.43` 即可，0.6.6 会自动用实际绑定端口刷新，`refreshLanPublicBaseUrlPort`）。
- 复制时桌面端仍在跑：SQLite 的 `-wal`/`-shm` 也一并复制，dev 副本索引状态会报 `LOCAL_INDEX_DISCOVERY_INCOMPLETE`（索引内 transcript 路径仍指向原 home 下的文件，dev 副本里没有），**属正常现象**；SQLite 库本体完好，数据可读写。

### 10.3 启动命令（端口 7788，对外 0.0.0.0）

```bash
cd /home/zeaxion/myproject/cchaha-06scode
CLAUDE_CONFIG_DIR=/home/zeaxion/cc-haha-dev \
CLAUDE_H5_DIST_DIR=/home/zeaxion/myproject/cchaha-06scode/desktop/dist \
~/.bun/bin/bun run desktop/sidecars/claude-sidecar.ts server \
  --app-root /home/zeaxion/myproject/cchaha-06scode \
  --host 0.0.0.0 --port 7788
```

关键点：
- **`--app-root` 必填**：sidecar launcher（`desktop/sidecars/launcherRouting.ts` 的 `parseLauncherArgs`）缺省会抛 `Missing --app-root`；dev 模式指向仓库根即可（preload.ts 只设 MACRO 并 chdir 到 `CALLER_DIR`，不依赖 app-root 是 asar）。
- 端口/绑定：`--host`/`--port` 在 `src/server/index.ts` `resolveServerOptions` 解析（env `SERVER_HOST`/`SERVER_PORT` 兜底，默认 127.0.0.1:3456）。
- dev 模式下会话 CLI 子进程：`resolveClaudeCliLauncher`（`src/utils/desktopBundledCli.ts`）因 execPath 是 bun 而非 sidecar 二进制而返回 null，走 `bin/claude-haha` 脚本路径（内部再 spawn bun 跑 `src/entrypoints/cli.tsx`）——所以 CLI 能力无需编译 sidecar 二进制。

### 10.4 H5「允许所有 IP」的 0.6.6 语义

- 0.6.6 的 H5 鉴权**没有** `requireToken` 字段（那是旧§二本地优化，0.6.6 `normalizeStoredSettings` 会静默丢弃该字段）；门槛只有 H5 token。
- 鉴权策略（`src/server/h5AccessPolicy.ts`）：
  - 外部 IP 浏览器请求 → `classify==='h5-browser'`，能力路径（`/api/`、`/ws/`、`/proxy/`、`/local-file/`、`/preview-fs/`）需 Bearer H5 token；
  - loopback（127.0.0.1/::1/localhost，且无代理头、URL hostname 也是 loopback）→ `local-trusted`，免 token；
  - 静态页（`/`、`/assets/`）不鉴权，任何人可打开首页。
- 因此「允许 0.0.0.0/0」= `--host 0.0.0.0` + `h5Access.enabled: true` + 有效 token；外部 IP 带 token 即可全量访问，**无需任何私网豁免代码**（旧§二的 requireToken 开关/私网豁免是叠加在此之上的新开关，见第一章）。
- dev 复用桌面端同一 token：`h5_H7kDPNb-KkhMnULdmQ-B0eoAd8ey-Pcc9PhtcpbeSUQ`。

### 10.5 验证结果（2026-09-24）

| 验证点 | 结果 |
|--------|------|
| 启动日志 | `[Server] Claude Code API server running at http://0.0.0.0:7788` |
| 静态首页（外部 IP，无 token） | 200（index.html 11133 bytes） |
| `/api/sessions` 外部 IP 无 token | 401 `Missing H5 access token` |
| `/api/sessions` 外部 IP 带 token | 200，索引 `discovered:23/indexed:23`，databaseBytes 78561280 |
| `/api/sessions` loopback 无 token | 200（local-trusted，符合策略） |
| `/api/h5-access`（控制面，H5 token） | 403 `can only be changed from the local desktop app`（控制面需 desktop process token，符合设计） |
| 与桌面端共存 | 8877（桌面）与 7788（dev）同时 LISTEN，数据目录独立互不干扰 |

### 10.6 注意事项 / 坑位

- **改过 H5 前端源码后必须重 build 并重启 sidecar**：sidecar 直接伺服 `desktop/dist/` 静态产物，源码改动不会热更。2026-09-24 实例：`desktopRuntime.ts` 16:09 加入免 token 直连逻辑，dist 还是 15:23 的旧产物 → LAN 设备（192.168.10.140）访问仍弹「需要访问令牌」；重跑 `cd desktop && node ./node_modules/vite/bin/vite.js build` + kill/重启 sidecar 后解决。判断 bundle 是否过期：比对 `dist/index.html` mtime 与 `desktop/src/` 改动文件 mtime。
- dev 副本与桌面端**独立写库**：在 dev 上做的会话/设置改动不会回到 `~/.claude/cc-haha`，反之亦然；需要回灌时手动合并。
- 改 `src/*.ts` 后 sidecar 需**重启**才生效（bun 直接跑源码无热更）；H5 前端改动需重跑 `desktop && bun run build`。
- 停 dev：直接 kill sidecar 进程；`~/.cc-haha-dev` 副本可随时删掉重拷。
- `LOCAL_INDEX_DISCOVERY_INCOMPLETE` 出现时列表接口 `total` 可能为 0（列表作用域=活跃会话索引），但索引计数正常；若需要完整列表，可在 dev 副本上重建 local index 或从桌面端同步。

---

## 十一、H5 悬浮快捷入口（任务列表 / 终端 / 文件浏览 / 审查）（源参考：旧§5.2 移动端 FAB，✅ 2026-09-27）

**需求**：移动端（H5 手机浏览器）会话页右上角缺少桌面端的任务列表 / 终端 / 文件浏览 / 审查入口（0.6.6 现状：`AppShell.tsx:406` 移动端不渲染 TabBar；三面板均硬编码 `!isMobileLayout` 禁用）。需为移动端提供悬浮（FAB）快捷入口，点击展开菜单打开对应面板，面板以全屏 overlay 呈现。

**参考（旧 fork §5.2 MobileQuickActions，2026-08 已实施，模式可复用）**：
- 旧实现 `desktop/src/components/chat/MobileQuickActions.tsx`：圆形 FAB（`add` 图标）→ 点击横向展开 3 个带图标+文字按钮（任务列表 `assignment` / 终端 `terminal` / 文件浏览 `folder`）；点外部或再点 FAB 收起（`useDismissable`）；FAB `absolute` 定位在 ChatInput 右上角半重叠，仅移动端渲染。
- 动作路由：任务列表 → `useActivityPanelStore.open(activeTabId)`；文件浏览 → `workspaceStore` setMode('workspace')+openPanel；面板移动端全屏 overlay（fixed 全屏 + slide-in + 顶部标题栏 + 关闭按钮），去掉面板的 `!isMobileLayout` 硬禁。
- 旧版含横屏适配（顶栏缩高、输入框缩小、chip 归位 toolbar、MobileBottomSheet 缩放、FAB pointer-events 修复等）——本次按需取舍，先做竖屏核心，横屏适配视验证情况跟进。

**与旧版的差异（本次范围）**：
- 入口 4 项 = **任务列表 / 终端 / 文件浏览 / 审查**（旧版是 任务列表/终端/文件浏览 3 项；本次在其基础上新增「审查」——审查 = 文件浏览面板的 review tab，`workspaceReviewStore`，i18n `workspace.reviewTabTitle`「审查」）。
- **终端**：与文件/审查共用移动端全屏 overlay（同一 `WorkspaceSurface dock="side"` 容器），区别仅在 `openWorkspaceTarget` 的 `target.kind`：文件=`{kind:'file',path:''}`（preview:true），审查=`{kind:'review'}`，终端=`{kind:'terminal',cwd:getSessionTerminalCwd(session)??'',dock:'side'}`——终端 tab 由 `WorkspaceSurface` 内 `TerminalPanel` 渲染（H5 终端桥接，WS `/ws/terminal`，spawn 走 `terminalWs`）。

## ✅ 实施（2026-09-27，patch `h5-mobile-quick-actions.patch`，9 文件 481 行）

**0.6.6 现状核对（调研结论）**：
- 任务列表已有移动端 overlay 先例：`ActiveSession.tsx:971-983` 在 `isMobileLayout` 下渲染 `SessionActivityPanel placement="overlay"`（需 `hasVisibleActivity` 才出现）；FAB 回调只需 `activityPanelStore.open(activeTabId)`（即 `openActivityPanel`）。
- 文件/审查无独立面板 store——0.6.6 已并入 `useWorkspaceStore`：`openTarget(sessionId, target)`（`kind:'file' path:''` = 文件树+空 pane，`kind:'review'` = review tab）；封装 `openWorkspaceTarget(request)`（`lib/workspace/openTarget.ts:26`）。**移动端硬禁**在 `ActiveSession.tsx:373-375` `workspaceEnabled = ... && !isMobileLayout`（side dock 因此不渲染）→ 本章新设计点=移动端用全屏 overlay 呈现 workspace。
- FAB 锚点：0.6.6 `ActiveSession.tsx` 渲染处是裸 `<ChatInput/>`，无旧 fork 的 `<div className="relative">` 包裹 → 本次恢复该 relative 包裹，FAB `absolute -top-[14px] right-2.5` 半重叠挂输入框右上。
- overlay 先例：`MobileBottomSheet.tsx`（createPortal + `--z-sheet` backdrop）+ `SessionActivityPanel placement='overlay'`。

**实现**：
1. **`desktop/src/components/chat/MobileQuickActions.tsx`（新增，移植旧 fork 模式）**：props `{onOpenTasks, onOpenTerminal, onOpenFiles, onOpenReview}`；`useState` open + `containerRef`；`useDismissable({open, refs:[containerRef], onDismiss:()=>setOpen(false), stopEscapePropagation:true})`（点外部/Esc 收起）；`run(action)`=先 `setOpen(false)` 再执行 action（点项立即收起菜单）；4 胶囊按钮 icons `assignment`/`terminal`/`folder`/`rate_review`（16px）+ i18n `chat.openTasks/openTerminal/openFiles/openReview`；FAB `h-[39px] w-[39px] rounded-full`、`bolt` 23px、open 时 `rotate-45`、`aria-label`/`aria-expanded`（`chat.quickActions`）；容器 `pointer-events-none absolute -top-[14px] right-2.5 z-[var(--z-dropdown)]`，`data-testid="mobile-quick-actions"`。
2. **`desktop/src/pages/ActiveSession.tsx`**：① 新增 import（`openWorkspaceTarget`/`MobileQuickActions`/`IconButton`）；② `workspaceIsGitRepo` 后加移动端状态——`memberInfo`/`isMemberSession`（复用 composer 门控：`useTeamStore.getMemberBySessionId` 或 `activeTabType==='subagent'`）、**本地 `mobileWorkspaceOpen` useState**（而非派生 store layout——后台 `openTarget` 不得弹 overlay，仅 FAB 显式点按才弹）、`mobileLayout` selector、派生 `mobileWorkspaceVisible`（`isMobileLayout && !isMemberSession && activeTabId && isSessionTabState && mobileWorkspaceOpen && layout!=='hidden'`）、`useEffect` 随 `activeTabId` 变化重置、`handleMobileOpenWorkspace`（`openWorkspaceTarget` + `preview:true`（file）+ `setOpen true`）、`handleMobileCloseWorkspace`（`setOpen false` + `setLayout hidden`）；③ JSX 加移动端全屏 overlay（`fixed inset-0 z-[var(--z-sheet)]`，顶栏 `workspace.panelLabel` + `IconButton close` `data-testid="mobile-workspace-close"`，内容 `WorkspaceSurface dock="side"`，`reviewUnavailableReason` 依 `workspaceIsGitRepo===false`）+ 恢复 `<div className="relative">` 包裹 `ChatInput` 并挂 `MobileQuickActions`（门控 `isMobileLayout && !mobileWorkspaceVisible && activeTabId && !isMemberSession && isSessionTabState`）。`handleMobileOpenWorkspace` 支持 3 种 `kind`：`file`（`openWorkspaceTarget({kind:'file',path:''},preview:true)`）、`review`（`openWorkspaceTarget({kind:'review'})`）、`terminal`（`openWorkspaceTarget({kind:'terminal',cwd:getSessionTerminalCwd(session)??'',dock:'side'})`）——终端与文件/审查共用同一全屏 overlay 容器，由 `WorkspaceSurface` 内部 tab 切换区分。
3. **i18n 5 语言**（`en/zh/zh-TW/jp/kr.ts`，插 `chat.refreshSession` 后）：`chat.quickActions`（Quick actions/快捷功能/快捷功能/クイック操作/빠른 작업）、`chat.openTasks`（Tasks/任务列表/任務列表/タスク一覧/작업 목록）、`chat.openTerminal`（Terminal/终端/終端/ターミナル/터미널）、`chat.openFiles`（Files/文件浏览/檔案瀏覽/ファイル閲覧/파일 탐색）、`chat.openReview`（Review/审查/審查/レビュー/검토）。
**验证**：
- 单测：新增 `MobileQuickActions.test.tsx` 3 用例（默认折叠无 4 项 / 点 FAB 展开 4 项+`aria-expanded` / 点 Files 触发 `onOpenFiles` 一次其余零次+折叠）；`ActiveSession.test.tsx` 既有移动测试补「后台 openTarget 不弹 overlay 但 FAB 在」+ 新用例「点 Files 打开全屏 overlay（`workspace-surface-side` 在、`workbench-panel` 不在）→ 关闭后 overlay 卸载且 `layout==='hidden'`」+「点 Terminal 打开终端 overlay（`workspace-terminal-*` 在）→ 关闭」断言。
- `tsc -b` exit 0；受影响 `MobileQuickActions`+`ActiveSession`+`AppShell` 58/58；**全量前端 vitest 6150 pass / 0 fail / 6 skipped**（基线 6146，+4 新用例，零回归）；`vite build` App-DMDs5MZr.js。
- **live 7788 iPhone 14（390×844 @3x）全验证**：FAB「快捷功能」展开 4 项（任务列表/终端/文件浏览/审查，图标 assignment/terminal/folder/rate_review）；点「文件浏览」→ overlay 全屏 `0,0,390×844` 完美覆盖 + 文件树正常渲染（项目文件列表+内容面板+底部标签条）；点「审查」→ overlay 正确渲染 review tab（比较范围/未暂存/还原全部/暂存全部 + 文件 diff 列表）；点「终端」→ overlay 渲染终端 tab（`workspace-terminal-*` + xterm），WS spawn 后显示 zsh prompt `/tmp/project-root %`（H5 终端桥接全链路）；点关闭 → overlay 卸载、正常回到会话页、FAB 复现。

---

## 十二、src/server 既有 22 条测试失败清零（✅ 2026-09-27）

> 基线 2f8d819d 上 `bun test src/server` 存在 22 条既有失败（与本次优化无关、纯基线遗留）。本项将其**全部清零**（3396 pass / 0 fail / 0 error），达成「零失败」基线，后续任何回归都能被立刻发现。

**根因分类**（8 文件，4 修代码 + 4 修测试）：

| 簇 | 条数 | 根因 | 修法 |
|---|---|---|---|
| git locale（workspace×5 + sessions×2） | 7 | `getGitRepoInfo` 用英文 stderr 子串 `not a git repository` 判非 git 仓库；本机 git 中文 locale 输出 `不是 git 仓库` → 误判 `state:'error'` | **修代码** `workspaceService.ts`：移植 `reviewService.ts` 的退出码探针 `git rev-parse --is-inside-work-tree`（`isNotAGitRepository`），`runGit` 加 `failedToRun` 区分「git 没跑起来」vs「跑了但拒绝」；一处修复覆盖 7 条 |
| ambient env 泄漏（conversation×4 + e2e×1） | 5 | 测试非 hermetic：本机 dev shell 导出的 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`/`CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS`/`CC_HAHA_*_ACCESS_TOKEN` 泄漏进 `buildChildEnv`/CORS 判定 | **修测试**：`conversation-service.test.ts` #1033 补清 `EMIT_SESSION_STATE_EVENTS`、#1307 补清 `FIRST_TOKEN_TIMEOUT_MS`；`full-flow.test.ts` 加 `TOKEN_ENV_KEYS` 保存/删除/恢复 |
| findSessionFile 无界全文读（sessions×2 + recovery×1 + subagent×1） | 4 | `findSessionFilesFromFiles` 对每个候选文件 `readJsonlFile` 全文解析仅为排序优先级；mock throw 被吞 → 返回 null，破坏 inspection coalescing/launchInfo/subagent lookup | **修代码** `sessionService.ts`：文件系统回退路径改 mtime-only 排序；**仅当同 id 有 ≥2 个候选文件**（worktree transcript vs 占位符）才做 transcript 偏好读（`matches.length > 1`），单文件场景零读 |
| 协作游标 depth 计数 | 1 | `sessionCollaborationService` 同物理页内 `end` 游标前进也 `depth+1`，8 页上限截断 130→80 条 | **修代码**：`depth` 仅在跨物理页（`page.page.nextCursor`）时递增，同页 `end` 游标保持 depth |
| 缺依赖 500（h5-access-auth×2） | 2 | `@whiskeysockets/baileys` 仅声明于 `adapters/package.json` 未装根 node_modules；`adapters/whatsapp/session.ts` 顶层静态 import → `/api/adapters` 500 | **修代码** `adapters/whatsapp/session.ts`：改动态 `import()`（懒加载意图），顶层只留 `import type`；缺依赖只在真正 login 时失败 |
| 平台耦合测试（connector×1 + workspaceWatch×1） | 2 | connector legacy 版本正则只认 `darwin\|win32`（本机 linux 夹具 `0.9.0-linux-x64` 失配 → 回落 1.0.0）；workspaceWatch 等 rename 后的**新名** `b.ts`（inotify 只报旧名 `a.ts`） | **修测试**：`connectorService.ts` 正则放宽平台 token 为 `[a-z]+`；`workspaceWatch.test.ts` 等待各平台都会产生的 `a.ts`（写操作触发） |

**验证**：
- `bun test src/server` 全量 **3396 pass / 0 fail / 0 error**（基线 22 条全清，零新增）。
- 逐簇回归：conversation-service 75/75、sessions 315/315、workspace-service 20/20、historyRecovery 8/8、subagent 44/44、collaboration 4/4、connectorService 24/24、workspaceWatch 10/10、h5-access-auth 53/53、adapters 41/41。
- 重点语义改动（协作游标）额外跑通全部协作相关测试（api/sessionCollaboration、e2e/session-collaboration、CollaborationService 39/39、CollaborationHost、CollaborationAuth 等）。
- `desktop tsc -b` exit 0。

**patch**：`modify/patches/server-test-baseline-zeroing.patch`（8 文件 324 行，链位 13，基线 6d4fd126）。

**13 链全验证**（`git worktree add --detach /tmp 2f8d819d` + 软链 node_modules，按序 `git apply` 全部 13 patch）：全干净；apply 后 vs 工作树仅 4 处已知非章 delta（`bun.lock`、`desktop/src/pages/TerminalSettings.tsx`、`desktop/src/lib/providerModels.ts`、`desktop/src/components/chat/MessagePayloadRetention.test.tsx`——均属独立 commit 的非章改动）。

## 十三、pi-vcc 算法压缩移植 + 双后端热切换 + vcc_recall 工具（参考 @sting8k/pi-vcc 0.8.0，✅ 2026-09-25）

> 移植 [pi-vcc](https://github.com/sting8k/pi-vcc)（"Algorithmic conversation compactor — transcript-preserving structured summaries, no LLM calls"）到 cc-haha。核心动机：现有 `/compact` 与 auto-compact 全走 **LLM 摘要**（`streamCompactSummary`，一轮完整模型调用，token 成本 + 延迟高，且摘要有丢失/幻觉风险）。pi-vcc 用**纯算法**（零 LLM）从消息窗口编译出 5 个语义 section + 一份 brief transcript，原始细节**不另存**——依赖已有 session JSONL 持久化，`vcc_recall` 工具按全局 message index（`#N`）无损检索回被压细节。

### 需求背景
- 用户拍板（AskUserQuestion）：范围=**核心压缩 + recall 工具 + 双后端 UI**；挂接=**旁路摘要步、可切换后端**；默认=**默认算法压缩接管全部，设置中可手动更换，且运行中可直接切换（热切换）**。
- 参考移植范例：`/tmp/opencode-vcc`（rumisle/opencode-vcc）——逐字 vendor pi-vcc 0.8.0 core + OpenCode↔pi 消息 adapter，是最佳跨框架移植范例。

### 0.6.6 现状核对
- LLM 摘要替换点=`src/services/compact/compact.ts` 的 `compactConversation`（:534 起 `streamCompactSummary` + `PROMPT_TOO_LONG` 重试循环）；下游消费（`buildPostCompactMessages` :362-370、`annotateBoundaryWithPreservedSegment` :381-399、`query.ts`/`autoCompact.ts`/`inProcessRunner.ts`/`commands/compact/compact.ts`/`REPL.tsx partialCompact` 读 `result.messagesToKeep`）均经 `CompactionResult` 字段，VCC 字段天然兼容。
- 设置 8 步链范本=`sendThinkingHistory`（第八章）。`src/types/message.ts` 是 @generated Proxy stub，`Message` 类型宽松（判别字段 `.type`）。

### 实施方案（57 文件，5316 增 / 34 删）
1. **算法核心移植** `src/services/compact/vcc/`（38 个 .ts，逐字 vendor pi-vcc 0.8.0）：
   - `vendor/core/`：`summarize`（`compile`/`compileRanked`+`mergePrevious` 逐 header 合并）、`brief`（tool_result 省略、连续相同 tool 行折叠 xN、bash heredoc 体删+pipe-tail 剥 `BASH_CAP=240`）、`build-sections`（Session Goal / Files And Changes / Commits / Outstanding Context / User Preferences 5 段 + `extractOutstandingContext` blocker 正则）、`format`（`BRIEF_MAX_LINES=120` 保尾部、`wrapLongLines` 120ch、`RECALL_NOTE`）、`rank`（`scoreBlock` recency*12/user+18/assistant+10/edit-tool+34/非零退出+24/trivial-bash-16 + `boostAdjacency`）、`search-entries`（BM25-lite K=1.2 B=0.75 + regex 双路 + drill-down `#N:path:full`）、`global-indices`/`jsonl`（0.8.0 新增，#N 计数 + 分块流读）。
   - `vendor/extract/`：`goals`/`files`/`preferences`/`commits`。
   - **cc-haha 适配层**（非 vendor）：`adapter.ts`（cc 消息→pi NormalizedBlock）、`ccGlobalIndex.ts`（`buildCcGlobalIndexByUuid` 保 `#N` 跨压缩稳定）、`vccCompact.ts`（`runVccCompaction` 主入口，文件不可读时 `buildIndexFromMessages` 兜底）、`engine.ts`、`pi-ai.ts`（pi Message 类型 shim）、`recallLoader.ts`（`loadCcSessionFile` 复用 adapter 保 #N 对齐）、`recallDrillDown.ts`（`full` cap 50KB / preview 30 行）。
   - 编译产物 `.js`（38 个）是 tsc 输出，**不入 patch**（只取 .ts 源）。
2. **vcc_recall 工具** `src/tools/VccRecallTool/`：`VccRecallTool.ts`（query / drill-down / touched / expand / page 五模式，`PAGE_SIZE=5`、`maxResultSizeChars=100_000`、`isReadOnly`）+ `prompt.ts` + `UI.tsx`；在 `src/tools.ts` `getAllBaseTools()` 注册（无 feature gate，工具计数 36→37）。
3. **双后端设置链**（8 步，`vccCompactBackend='algorithm'|'llm'` 默认 algorithm）：`src/utils/compactionBackend.ts`（`getCompactionBackend`——**热切换：compaction 时实时读设置**）、`settings/types.ts` z.enum、`desktop` types/settings + settingsStore 5 处（乐观 setter `setVccCompactBackend`）、`GeneralSettings.tsx` `COMPACTION_BACKEND_ITEMS` + Context compaction 区块（Dropdown，responseLanguage 范式）、i18n 5 语言 6 key、`remoteBrowserPolicy.ts` READ+WRITE 白名单+枚举校验器（**H5 必须同步否则 PUT 400**）、`supportedSettings.ts`、`remoteBrowserPolicy.test.ts` +6 断言。
4. **旁路接线** `src/services/compact/compact.ts`：新增 `maybeVccCompact`（`getCompactionBackend!=='algorithm'`→null 回落 LLM 路径），`compactConversation` 在 `getCompactPrompt` 前调用，VCC 命中时跳过 LLM 循环、`messagesToKeep` 走 `buildPostCompactMessages` 保留 tail、`annotateBoundaryWithPreservedSegment` 标注保留段；`logEvent('tengu_compact')` 加 `compactionBackend` 字段。

### 验证
- 单测：`VccRecallTool.test.ts` 10/10、`remoteBrowserPolicy.test.ts` 4/4（62 expect）、`compact`/`autoCompact` 26 pass / 76 expect。
- runtime probe（合成 8 条 cc 消息窗口）：`keptUserTurns=2/total=3`、5 section 编译、`messagesToKeep` 保 tail、`previousSummaryUsed=true` 且 merge 后文件去重。
- **全量零回归**：前端 `desktop vitest` **12300 pass / 12 skip / 0 fail**；server `bun test` .ts 全量 2871 pass / 1 fail——该 1 条为 `cron-scheduler-launcher`（proxy 固定端口 3456 漂移 flaky，单文件复跑 12/0 通过；VCC 未触碰 cron/proxy）。全量 `bun test src/server`（含 .js 孪生 6792 用例）9 条失败全在 VCC 未触碰的 proxy/端口竞态族（`h5-access-auth` 单文件 53/0、`cron-scheduler-launcher` 单文件 12/0 均通过）。
- **15 链全验证**（`git worktree add --detach /tmp 2f8d819d` + 软链 node_modules，按序 `git apply` 全部 15 patch：14 既有 + `vcc-compactor`）：全干净；apply 后 57 个 VCC 文件逐字节=工作树（diff 全空，0 差异）。

**patch**：`modify/patches/vcc-compactor.patch`（原 57 文件 5946 行；2026-09-26 子优化后重生成 **58 文件 6008 行**，链位 15，基线 2004cd16）。

### 子优化（2026-09-26）：设置页「上下文压缩」区块排版 + 下拉选项语言
- **用户反馈（verbatim）**：「设置项中，上下文压缩 字段内容和上面的思考内容紧贴在一起，需要先换行成独立小标题，另外里面的选项还是英文，选定后收起下拉列表看到的又是中文，也需要处理一下」。
- **根因 1（排版）**：`GeneralSettings.tsx` 的 compaction 区块（h2+描述+Dropdown）裸挂在 thinking 区块的 `</div>` 之后，没有像其他所有区块那样的 `<div className="mt-8">` 容器→与「思考」内容视觉上紧贴。
- **根因 2（选项英文）**：`COMPACTION_BACKEND_ITEMS` 是**模块级 const**，label/description 存的是 i18n **key 字符串**；而 `Dropdown` 组件（`ui/Dropdown.tsx:271/273`）对 `item.label`/`item.description` 按**裸字符串**渲染、不做 `t()`——于是展开的选项显示原始 key（`settings.general.compactionBackend.algorithm.label` 这类英文串）；收起后的 trigger 是手工 `t()` 的→中文。两者语言不一致。
- **修复**（2 处）：①compaction 区块包进标准 `<div className="mt-8">` 独立小节（Dropdown 自身的 `mb-8` 去重）；②`COMPACTION_BACKEND_ITEMS` 移入组件内、label/description 改为 `t(...)` 实时翻译（与同文件 `RESPONSE_LANGUAGES`/`outputStyleItems` 的 `t()` 范式一致）。i18n 键本身 5 语言早已齐备，无需加键。
- **验证**：tsc exit 0；新增回归测试 `GeneralSettings.compaction.test.tsx`（zh locale 挂载真实 GeneralSettings→点开 compaction 下拉→断言两选项均渲染中文 label、listbox 内不出现原始 key）1/1 过；settings 族 3 文件 10/10；**全量前端 vitest 12302 pass / 12 skip / 0 fail**（=基线 12300+新增 2 条孪生用例，零回归）；**19 链全验证**：`vcc-compactor.patch` 重生成（57→58 文件，基线 2004cd16，worktree@A 态叠加法）后 fresh worktree@2f8d819d 顺序 apply 19 patch 全干净，`GeneralSettings.tsx`+测试与工作树逐字节一致（全树 diff 仅 5 个已知非章 delta：bun.lock、TerminalSettings.tsx、providerModels.ts、MessagePayloadRetention.test.tsx、preview-agent.js）。

## 十四、H5/移动端支持打开插件市场（✅ 2026-09-25）
> 用户 verbatim：「还有，移动端需要能打开插件市场，这个也需要处理一下。也纳入H5访问优化内」。

### 现状核对
- 插件市场页面=`desktop/src/pages/ExtensionMarket.tsx`（tab 容器：plugins→`Connectors.tsx`、skills→`Market.tsx`），路由=tab 类型（`ContentRouter.tsx:39-40`，market/connectors→`<ExtensionMarket/>`）；入口=`Sidebar.tsx:1058` NavItem（`MARKET_TAB_ID`，i18n `sidebar.extensions`「技能·连接器」）+桌面 `TabBar.tsx` 标签。
- 纯 HTTP 无宿主依赖：`api/market.ts`→`/api/market/*`，install 由服务端本机 fs 执行（`services/market/installService.ts`）；服务端 H5 白名单（`remoteBrowserPolicy.ts`）只 gate `/providers`、`/settings`，`/api/market` 直通无 403。
- H5 被挡两点：①`Sidebar.tsx:1058` 市场 NavItem 包在 `{!isMobile && ...}` 内→移动端侧边栏抽屉无市场按钮；②`AppShell.tsx:275` 移动端 effect 早退条件不含 market→非 chat/settings 的 market tab 被强制踢回会话。

### 实施方案（2 文件 3 处）
1. `Sidebar.tsx`：市场 NavItem 移出 `{!isMobile}` 包裹（scheduled 仍隐藏）；
2. `AppShell.tsx:275`：早退条件加 `|| activeTab?.type === 'market'`；
3. `AppShell.tsx` mobile-session-header：market tab 标题分支（`t('sidebar.extensions')`，settings 分支范式）。

### 验证
- tsc exit 0；Sidebar/AppShell/ContentRouter 3 文件 135/135；全量前端 vitest 12300 pass/12 skip/0 fail（仅既有 MessageList 虚拟化负载 flaky，单跑 198/198）。
- **live 7788 移动端（iPhone 14 390×844）**：侧边栏抽屉出现「技能·连接器」按钮→点击→header 标题「技能·连接器」+ 插件列表渲染（飞书/钉钉/企业微信等连接器卡片）。
- **16 链全验证**（worktree@2f8d819d 顺序 apply 16 patch：15 既有 + `h5-mobile-market`）全干净；链上 Sidebar/AppShell 与工作树逐字节一致（已知非章 delta 不变：bun.lock、TerminalSettings.tsx、providerModels.ts、MessagePayloadRetention.test.tsx）。

**patch**：`modify/patches/h5-mobile-market.patch`（2 文件 61 行，链位 16，基线 10d7d52a）。

## 十五、H5/移动端支持打开计划任务（定时任务）页（✅ 2026-09-26）

> 用户 verbatim：「再把计划任务也给移动端访问H5打开适配」。

### 现状核对
- 计划任务页 `desktop/src/pages/ScheduledTasks.tsx` 纯 `taskStore`+HTTP（`api/tasks`），无桌面宿主依赖，移动端可打开；布局 `px-11` 在 390px 下两侧占 88px 偏宽。
- 与十四章同构的两处拦截：①`Sidebar.tsx` 定时任务 NavItem 包在 `{!isMobile && ...}` 内→移动端抽屉无入口；②`AppShell.tsx:275` 移动端 effect 早退条件不含 scheduled→scheduled tab 被踢回会话。

### 实施方案（3 文件 3 处 + 1 测试更新）
1. `Sidebar.tsx`：定时任务 NavItem 移出 `{!isMobile}` 包裹；
2. `AppShell.tsx:275`：早退条件加 `|| activeTab?.type === 'scheduled'`；
3. `AppShell.tsx` mobile-session-header：scheduled tab 标题分支（`t('sidebar.scheduled')`，settings/market 分支范式）；
4. `ScheduledTasks.tsx`：内容容器 `px-11` → `px-4 lg:px-11`（移动端响应式）。
5. `Sidebar.test.tsx`：「keeps mobile navigation focused on chat sessions」用例原断言移动端无 Scheduled/Extension Market——该断言在十四章（market 上移动端）后已失配（HEAD 即失败），本轮随 scheduled 上移动端一并更新为「两者均在」。

### 验证
- tsc exit 0；Sidebar/AppShell/ContentRouter 3 文件 135/135（含更新后的移动端导航用例）；全量前端 vitest 12298 pass / 12 skip / 2 fail（2 条=既有 MessageList 虚拟化负载 flaky「preserves the expanded change card through virtual unmount」，.tsx/.js 孪生各 1，单跑 198/198 过）。
- **live 7788 移动端（iPhone 14 390×844）**：侧边栏抽屉出现「定时任务」→点击→页头 h1=定时任务、新建任务按钮可用、桌面在线提示条正常显示。
- **18 链全验证**（worktree@2f8d819d 顺序 apply 18 patch：16 既有 + `h5-mobile-scheduled` + `connector-linux-platform`）全干净；链上 8 个本章+十六章文件与工作树逐字节一致（diff 全空，0 差异）。

**patch**：`modify/patches/h5-mobile-scheduled.patch`（4 文件，链位 17，基线 cc88daa5）。

## 十六、连接器目录 Linux 平台支持（x64/arm64）（✅ 2026-09-26）

> 用户拍板（AskUserQuestion）：「加 Linux 平台支持」。起因=移动端 H5 市场页连接器卡片全显示「当前平台不支持」。

### 现状核对
- `supported` 由**服务端**算（`src/server/services/connectorService.ts:45` `def.platforms.includes(process.platform-process.arch)`）；H5 场景连接器运行时在服务端，判定对象正确。本机=linux-x64，旧目录只声明 darwin/win32→全部不支持（桌面 Linux 用户同样看到，语义一致）。
- 关键=CLI 三连接器（feishu/dingtalk/wecom）走 `cliAdapter`→`managedRuntime.prepareManagedRuntime`，**按平台 pin 下载 URL + sha256/sha512 哈希**（`getArtifactPins` 缺 pin 即抛 "no pinned artifact"）；且 `:225` 原 `os = platform==='win32'?'windows':'darwin'` 把 Linux 误映射成 darwin URL。
- 上游 Linux 产物确认（WebFetch）：飞书 @larksuite/cli=Go 原生（goreleaser linux amd64/arm64）；钉钉 dingtalk-workspace-cli=Go/CGO（glibc 2.17+，官方 macOS/Linux(x64/arm64)/Windows）；企微 @wecom/cli=Rust（npm 平台包，官方列 macOS/Linux/Windows，**无 win32-arm64**）。skill/remote 连接器平台无关（文件下载/MCP HTTP），仅需声明平台。

### 实施方案（4 文件）
1. `catalog.ts`：feishu/dingtalk/wecom `platforms` 加 `linux-x64`、`linux-arm64`（wecom 同）；`skillCatalog.ts`、`remoteCatalog.ts` 同加（保守统一）。
2. `managedRuntime.ts`（核心）：
   - `larkArchiveHashesV1_0_95` + linux-x64 `7da92d42…`/linux-arm64 `063012a6…`（sha256 归档）；
   - `wecomArchiveHashesV1_2_1` + linux-x64 `rRWW/Z0…`/linux-arm64 `ndgR2jV…`（sha512 base64 归档）；
   - `initialBinaryHashes` 三连接器各加 linux-x64/linux-arm64 二进制 sha256（feishu `44356a43…`/`8afae147…`；dingtalk `929ad4d0…`/`23c5e06b…`；wecom `a93389bd…`/`327faa17…`）；
   - `os` 映射修 `:225`→`'win32'?'windows':'linux'==='linux'?'linux':'darwin'`（Linux 走 lark-cli-…-linux-amd64.tar.gz / dws-linux-*.tar.gz / @wecom/cli-linux-* 平台包，均已验证 URL 可达）；
   - dingtalk 归档 sha512（`dingArchiveIntegrityV1_0_61`）复用同一 tgz 全平台共用，实测 base64 与既有 pin 逐字节一致；
   - legacy 版本回退正则（`connectorService.ts:55`）本就通用 `[a-z]+-(?:arm64|x64)$`，linux 目录名可解析。
3. 服务端 `.js` 孪生（untracked，bun 优先加载）同步 4 文件。

### 验证
- **6 个 Linux pin 全解析**：`getArtifactPins(def, 'linux-x64'/'linux-arm64')` 对三连接器全返回有效 integrity（不再抛 "no pinned artifact"）。
- **端到端真实 prepare**：live 7788 触发 `POST /api/connectors/feishu/prepare`→下载 14MB linux-amd64 归档→sha256 归档+二进制双校验→版本探针→`installed=True ver=1.0.95 status=needs-auth`；`/home/zeaxion/cc-haha-dev/connectors/runtime/feishu/1.0.95-linux-x64/lark-cli --version` 实际可执行（`lark-cli version 1.0.95`）。
- **测试**：`bun test src/services/connectors/` 416 pass / **0 fail**——加 linux 平台后**连修了 8 条既有平台耦合失败**（HEAD 为 408/8，这 8 条假设 darwin 宿主、在 linux 上先被 platforms 门控挡下而 fail；加 linux-x64 后进入 pin 校验路径且通过）。tsc exit 0；全量前端 vitest 与基线一致（零回归）。
- **live 7788 移动端**：市场卡片「当前平台不支持」→「待连接账号」（supported=true 生效）。
- **18 链全验证**：同十五章（worktree@2f8d819d 顺序 apply 18 patch 全干净，8 文件逐字节=工作树）。

**patch**：`modify/patches/connector-linux-platform.patch`（4 文件 105 行，链位 18，基线 cc88daa5）。

## 十七、H5/移动端 技能市场页 header 布局适配（✅ 2026-09-26）

> 用户反馈（verbatim）：「主要是技能市场，该页面内大标题下面的文字排成了9行，这相当不合理。」

### 现状核对
- 移动端（390px）打开「技能」tab（`MarketHome`）实测：header 是 `flex flex-wrap`，三子项=图标 56px（`flex-shrink-0`）+ 标题/副标题列（`min-w-0 flex-1`）+ 右侧集群（`SourceStatusBar` 228px + 「已安装技能」按钮 146px）。390px 减 padding 后可用 342px，被图标+右侧集群 min-content 挤死，**标题列只剩 16px**：副标题「浏览、预览并安装来自 ClawHub 与 SkillHub 的技能。」折 **15 行**（用户设备更宽折 9 行），标题「技能市场」一字一行，header 总高 **508px ≈ 屏幕 60%**。
- 桌面（≥1024px）同布局无此问题（空间充足，右侧集群同行右对齐）。

### 实施方案（1 文件 1 行，纯响应式 CSS）
- `desktop/src/components/market/MarketHome.tsx:121` 右侧集群容器加 `max-lg:items-start max-lg:basis-full`：窄屏（<1024px）换行独占一行（`basis-full` 强制 100% 宽），标题列拿满剩余宽度；桌面端 `max-lg:` 不生效，布局零变化。
- 无新 i18n 键、无组件结构改动、无逻辑改动。

### 验证
- **live 7788 移动端 390×844**：副标题 15 行→**2 行**（宽 262px），标题 1 行，header 508px→**158px**；右侧集群（来源状态 + 已安装技能按钮）落到标题行下方，信息全保留。
- **桌面 1280px**：header 74px，按钮与标题同行（`sameRow=true`），副标题 1 行 594px——桌面布局零变化。
- **tsc exit 0**；市场+页面 vitest 872/872；**全量前端 vitest 12300 pass / 12 skip / 0 fail**（=基线零回归）。
- **19 链全验证**（worktree@2f8d819d 顺序 apply 19 patch：18 既有 + `h5-mobile-market-layout`）全干净；`MarketHome.tsx` 与工作树逐字节一致（全树 diff 仅 4 个已知非章 delta：bun.lock、TerminalSettings.tsx、providerModels.ts、MessagePayloadRetention.test.tsx）。
---

## 十八、Computer Use 解锁 Linux（X11）平台（✅ 2026-09-26）

### 需求背景

Computer Use（电脑操作）功能此前仅对 macOS（`darwin`）与 Windows（`win32`）开放：Linux 上设置页/会话侧看不到入口、MCP 工具不暴露、模型不知道会用。目标：让 **Linux（X11 桌面）** 走 Windows 同款的「像素面」兼容路线（screenshot/点击/键入/滚动 等 legacy pixel 工具 + Python helper），把 Computer Use 在 H5/服务端 Linux 场景解锁。

### 0.6.6 现状核对（调研结论）

- 平台判定是**分散内联**的，没有单一共享 platform 类型；`'darwin' | 'win32'` 联合类型在 **9 处生产代码** + 若干测试里内联出现（`common.ts`、`gates.ts`、`skillGate.ts`、`executor.ts`、`helperBridge.ts`、`pythonBridge.ts`、`mcpServer.ts`、`tools.ts`、`keyBlocklist.ts`、`computer-use.ts`、`computerUse.ts`(skills) 等）。
- **核心路由缝**在 `src/utils/computerUse/helperBridge.ts`：darwin→原生 `cu-helper` Swift daemon（AF_UNIX）；**else 分支（现仅 win32）→ `callPythonHelper`**。Linux 天然落入 else→Python 路线，无需新通道。
- **工具面选择**在 `src/vendor/computer-use-mcp/mcpServer.ts`：`caps.platform === 'win32'` → `buildLegacyComputerUseTools`（像素工具集）；darwin → 语义工具过滤到 `js`/`js_reset`。Linux 应路由到**像素面**，故 `mcpServer.ts:113` 与 `:190`（`legacyPixelFace`）需加 `|| platform === 'linux'`。
- **服务端能力映射** `resolveComputerUseCapability`（`computer-use.ts:247-314`）：win32→`windows-compat`、darwin→版本门控 `macos-native`、其余（含 linux）→`{supported:false, engine:'unsupported'}`。Linux 需新 engine 值（如 `linux-x11`）。
- **Python helper 目录** `runtime/`：现有 `win_helper.py` + `requirements-win.txt`，**无 linux helper**。Linux 需新增 `linux_helper.py`（mss 截图 + pyautogui 输入 + **python-xlib** 窗口枚举/前台/open_app）+ `requirements-linux.txt`（mss/Pillow/pyautogui/python-xlib；无 pywin32）。
- **UI** 不自己判平台，全靠服务端 `status.engine`/`status.platform` 分支（`ComputerUseSettings.tsx`）：`engine==='unsupported'`→不支持页；`'macos-native'`→原生页；否则→Windows 兼容 Python 安装流。Linux 走 else 的 Python 流即可，仅需 `PYTHON_DOWNLOAD_URLS` 与 `ComputerUseEnableDialog` 的 platform prop 补 linux 分支。
- 已有先例：`growthbook.ts:36`、`platform.ts:7`、`env.ts:11`、`openTargetService.ts` 的 platform 联合类型**已含 linux**——只是 computer-use 子系统自己没跟上。
- 测试现状：`common.test.ts`、`gates.test.ts`、`computer-use-api.test.ts` 等多处**断言 linux 当前 unsupported**，加分支后需同步更新（不是回归，是预期行为变更）。

### 实施方案（分两批，先门控/状态，后 helper）

**批次 A——门控放宽 + 状态页（让 Linux 可见、可进设置流）**
- `common.ts`：`isComputerUseSupportedPlatform` 返回 `platform is 'darwin'|'win32'|'linux'`；`getCliComputerUseCapabilities` 加 linux 分支（`screenshotFiltering:'none'`, `platform:'linux'`）。
- `gates.ts`：`shouldExposeComputerUseMcp` 加 `|| platform === 'linux'`（Linux 无原生二进制门控，直通）。
- `skillGate.ts:55`：`!== 'darwin' && !== 'win32'` 判定补 linux。
- `computer-use.ts`：`resolveComputerUseCapability` 加 linux→`{supported:true, engine:'linux-x11'}`；`checkStatus`/`openComputerUseSettings`/`supportedPlatform` 等处补 linux 分支（open-settings 可返回 null=无系统设置面板，或 xsettingsd 等）。
- `desktop/src/api/computerUse.ts`：`engine` 联合类型加 `'linux-x11'`。
- `ComputerUseSettings.tsx`：`PYTHON_DOWNLOAD_URLS` 补 linux URL；`ComputerUseEnableDialog` 的 `platform` prop 补 linux。
- 9 处内联 `'darwin'|'win32'` 联合类型逐一补 `'linux'`（mcpServer/tools/keyBlocklist/toolCalls/executor/windowsLegacyTools/skills）。
- **工具面**：`mcpServer.ts` 像素面选择改 `platform === 'win32' || platform === 'linux'`。

**批次 B——Linux 像素 helper（真正能操作桌面）**
- 新增 `runtime/linux_helper.py`：复用 win_helper 的 mss（截图）/pyautogui（鼠标键盘）骨架，窗口枚举/前台化/`open_application` 用 **python-xlib**（X11），`open_settings`/权限用 xrandr/xprop 探测；输入走 XTEST。
- 新增 `runtime/requirements-linux.txt`：`mss>=9.0.2,<10` / `Pillow>=11.3.0,<12` / `pyautogui>=0.9.54` / `python-xlib>=0.33`。
- `pythonBridge.ts`：helper 文件名/requirements 按平台选择（linux→linux_helper.py + requirements-linux.txt）；venv 用 `bin/python3`（unix 分支已有）。
- `computer-use.ts`：embedded runtime 常量导入补 linux 两份文件；`ensureRuntimeFiles` 按平台写。
- 系统依赖（文档记录，非代码）：X11 桌面 + `xdotool`/`xclip`（剪贴板）可选；XWayland 下部分 pyautogui 能力受限，需在状态页给提示。

### 验证（实施时逐批跑）

- 单测：computer-use 全族（`src/utils/computerUse/*.test.ts` + `src/vendor/computer-use-mcp/*.test.ts` + `src/server/__tests__/computer-use-*.test.ts`）；新增 linux 分支用例（linux→supported/像素面/linux-x11）。
- 前端：`ComputerUseSettings`/`computerUse` vitest + 全量前端（基线 12300 pass/12 skip/0 fail）。
- **live 7788 Linux 服务端**：`GET /api/computer-use/status` 应回 `{platform:'linux', supported:true, engine:'linux-x11'}`；设置页进入 Python 安装流而非「不支持」页。
- X11 实机冒烟（如有）：screenshot 能回图、left_click/type 生效。

### 实施记录（2026-09-26，批次 A+B 全部完成）

**批次 A 落地（24 文件，1231 ins / 75 del）**：按调研清单全量实施，另有 3 处调研时未预见、实施中发现的修：
- `src/server/api/computer-use.ts ensureRuntimeFiles`：原无条件写 win_helper+cursor badge→按平台选 `LINUX_HELPER_CONTENT`/`WIN_HELPER_CONTENT`，linux 跳过 badge。
- `src/utils/computerUse/executor.ts readClipboard/writeClipboard`：原 `platform==='win32'?callHelper:pbpaste/pbcopy` 会把 linux 误送 macOS `pb` 命令→改 `platform!=='darwin'?callHelper:pb`。
- `src/vendor/computer-use-mcp/windowsLegacyToolCalls.ts`：viaClipboard 非 ASCII 条件与单进程 type 优化 `platform==='win32'`→`platform!=='darwin'`（linux 同 Python 面走剪贴板/单进程整批 type）。

**批次 B 落地（2 新文件）**：
- `runtime/linux_helper.py`（986 行）：镜像 win_helper 全 26 命令面（JSON 单行 `{ok:true,result}`/`error_output(code)`，退出码 0/1/2=bad_command）。mss 截图 JPEG q75 LANCZOS（输出形状与 win 逐字段一致）；pyautogui 输入；python-xlib X11 窗口枚举/前台化；XDG `.desktop` 枚举 installed_apps（112 条实测）；psutil running_apps；pyperclip 剪贴板（需系统 xclip/xsel，无则 write 报错/read 空串——文档记录的系统依赖）；`KEY_MAP cmd/command/meta/super/win→'command'`（pyautogui Super）。简化=ForegroundLease 无物理输入监控（保留 user_interference/target_window_offscreen/point_outside_display 错误码语义），MUTATING/COORDINATE_COMMANDS 集合与 win 完全一致。
- `runtime/requirements-linux.txt`：mss>=9.0.2,<10 / Pillow>=11.3.0,<12 / pyautogui>=0.9.54 / python-xlib>=0.33 / psutil>=5.9.0 / pyperclip>=1.8.2。

**python-xlib API 踩坑（X11 实机冒烟暴露，3 处全修+实测通过）**：
1. `Drawable.get_property` 是 **4 参** `(property, property_type, offset, length)`——0 参/3 参调用全抛 TypeError 被 try/except 吞掉→pid 永远 None（症状=running_apps 0 条、frontmost null）。统一抽 `_read_property_value`（`Xatom.CARDINAL`/`Xatom.WINDOW` 作 property_type）。
2. `drawable.display` 是 `_BaseDisplay` 代理**无 `intern_atom`**→atom 解析改走 `disp.get_atom(name)`（`d.intern_atom` 只在完整 `Display` 对象上）。
3. `get_input_focus()` 返回 event 对象，焦点窗在 `.data['focus']` 且常为 None/PointerRoot→frontmost 优先 EWMH `_NET_ACTIVE_WINDOW`（root 属性，compositor 可靠维护，实测 gnome-terminal 解析成功），input-focus 兜底。
4. GTK 系窗（Nautilus 等 50/76 个）不发布 `_NET_WM_PID`→`_app_info_for_window` 加 WM_CLASS 兜底（`_app_info_from_wm_class`，instance/class 对当 bundleId+displayName）。
5. `pyautogui.moveTo(x, y, duration=...)` 非 `_duration=`（0.9.54 签名）。

**验证结果**：
- computer-use 全族 bun test（`src/utils/computerUse/*.test.ts` + `computer-use-api.test.ts`）：**24 fail = 干净基线 24 fail（git worktree@HEAD 对照法），零新增回归**（基线 24=helperBridge/cu-helper 快照族，mac 专属 daemon 路径，与本任务无关）。测试文件新增 linux 用例：common（linux→true+freebsd false+linux capabilities）、gates（linux→true）、api（linux→{supported:true,engine:'linux-x11',cuHelper unsupported_platform}+getUnsupportedComputerUsePlatformStep→null）、setup（linux→mcpConfig 含 computer-use+allowedTools 含 screenshot；unsupported 用例改 freebsd）、skillGate（linux 启用用例）。
- 前端：ComputerUseSettings(24)+EnableDialog(2)=26/26 绿；desktop tsc --noEmit exit 0；全量 desktop vitest **12454 pass / 4 fail（4=scripts/image-processor-packaging .js/.ts 孪生同一用例 `spawn bun ENOENT`，环境 PATH 问题非本任务引入）零新增回归**。
- **live 7788（dev sidecar 源码直跑）**：`GET /api/computer-use/status` 回 `{"platform":"linux","supported":true,"engine":"linux-x11","cuHelper":{"available":false,"reason":"unsupported_platform"},"python":{"installed":true,"version":"3.13.12"},"venv":{"created":false},"permissions":{"accessibility":null,"screenRecording":null}}`——venv 未建时 permissions null 符合预期（建 venv+装依赖后 helper check_permissions 回 {accessibility:true,screenRecording:true}）。
- **X11 实机冒烟（GNOME 桌面，/tmp/lh-test venv 装全 6 依赖）**：全 26 命令面过——check_permissions/{accessibility:true,screenRecording:true}、list_displays（1920x1080）、screenshot（resize 后 base64 回图）、zoom（targetWidth/Height 放大 200x150→400x300）、cursor_position、move/click/scroll/mouse_down/mouse_up/key/hold_key/type（全部 ok:true 且光标位置实测移动生效）、frontmost_app（_NET_ACTIVE_WINDOW→gnome-terminal-server）、app_under_point、list_running_apps（20 条）、list_installed_apps（112 条）、find_window_displays（displayIds:[0]）、read/write_clipboard（read 可用；write 需系统 xclip/xsel）、bad_command 退出码 2。

**系统依赖（部署文档口径）**：X11 桌面必须；XWayland 部分受限（窗口状态查询不可靠，guards fail open）；剪贴板 write 需 `xclip` 或 `xsel` 之一；XWayland 下建议状态页提示。

> 状态：✅已完成（2026-09-26，两批全部落地+实机冒烟通过）。

**patch**：`modify/patches/computer-use-linux-x11.patch`（24 文件 1758 行含 2 新文件 new file mode，20 链末位，基线=068b3ebd 起 19 链终态；20 链 worktree 顺序 `git apply --allow-empty` 全干净，24 文件与工作树逐字节一致）。

### 子优化① 平台化组件选择（2026-09-27，patch `computer-use-platform-components.patch` #34）

**用户指示**：「应该自动根据 windows/macos/linux 平台不同，所需组件不同」。

**核查结论：依赖清单本身早已分档且正确**——`runtime/requirements-{win,linux}.txt` 两份，与各自 helper 的 import **逐项对得上**：

| 平台 | helper | 独有依赖 | 对应 import |
|---|---|---|---|
| Windows | `win_helper.py` | `pywin32`、`screeninfo` | `win32con/win32gui/win32process/winreg`、`screeninfo` |
| Linux | `linux_helper.py` | `python-xlib` | `Xlib` |

服务端 `api/computer-use.ts` 也已按 `engine`（`macos-native`/`windows-compat`/`linux-x11`/`unsupported`）分派，前端设置页亦按 engine 分流（mac 走原生页并**明确拒绝**进入 Python 安装流）。**故不是「缺分档」，而是选择方式有洞。**

**缺陷**：`pythonBridge.ts` 用**二元三目**选清单——`isLinux ? 'requirements-linux.txt' : 'requirements-win.txt'`。macOS（或任何未知平台）**会落到 Windows 那份**（把 `pywin32` 装给 mac）。虽然正常路径被 engine 守卫挡住，但这是「靠上游拦截」而非「自身正确」。

**修复**：抽出显式平台表
```ts
export function pythonRuntimeFor(platform: NodeJS.Platform): PythonRuntimeComponents | null
//  win32 → { helper: 'win_helper.py',   requirements: 'requirements-win.txt' }
//  linux → { helper: 'linux_helper.py', requirements: 'requirements-linux.txt' }
//  其余（含 darwin）→ null：无 Python 组件
```
`ensureRuntimeFiles` 走该表（`null` 时不再同步任何 requirements）；`ensureBootstrapped` 在无组件集时**响亮拒绝**（而非装错平台的包）；`bootstrapPipIntoVenv` 的补救提示也按平台给（Windows 提示用官方安装器勾选 pip / `python -m ensurepip`，其余提示装系统 venv 包），不再对着 Windows 用户喊 `apt install python3-venv`。

**验证**：`pipInstall.test.ts` 新增 `pythonRuntimeFor` 两用例（各平台映射 + darwin/未知 → null）与 Windows 补救用例；linux 补救既有用例改为**显式传 `platform`**（原先依赖运行平台，在 Windows CI 会假失败）。合并跑 **15/15 通过**，改动文件 tsc 0 报错。

### 子优化② 无原生文件选择器时回退填入已探测路径（2026-09-27，patch `computer-use-python-path-fallback.patch` #35）

**问题**：解释器路径输入框点「浏览」在两种情形下拿不到选择器——**H5/浏览器**下原生文件选择器选的是**浏览器所在机器**的文件（而解释器在跑 sidecar 的机器上，永远选不中）；**Linux 无 portal** 时原生对话框也可能直接失败。原本两种情形都只留下一个空输入框让用户手抄路径。

**修复**：失败即回退——把服务端**已经探测到的解释器路径**填入草稿并提示确认保存（`fallbackToDetectedPythonPath()`，`ComputerUseSettings.tsx`）。新增 i18n 键 `settings.computerUse.pythonPathDialogDetected`（en/zh/jp/kr/zh-TW 五语言各 +1）。

**验证**：`ComputerUseSettings` 族测试（含新增用例）；五语言键对齐。

## 十九、bc 压缩后 context usage 不收敛（✅ 2026-09-26 已实施）

### 需求背景（用户 2026-09-26 verbatim）

「因为有bc中间件在前端助手和后端引擎中间，现在context usage只有持续增长到100%，没有随bc压缩收敛后显示真实usage和百分比，这个作为新优化项，先推进调研。」

### 调研结论：根因已坐实（live 实证）

**架构**：桌面 sidecar（cc-haha）→ bc/bili 中间件（:8878，无状态全量拼历史 + salvage 压缩）→ vLLM 引擎。sidecar 的 context 百分比**不读 bc 的任何信号**，完全本地计算：

**计算链**（`src/server/services/sessionService.ts`）：
1. `buildTranscriptContextEstimate`（:2938-3031）= 唯一显示源（inspection.contextEstimate → 前端 ContextUsageIndicator.tsx:391 直接取 `percentage`）。
2. `accumulateTranscriptContext`（:462-524）扫**追加式 transcript JSONL**：每条 user/assistant/attachment 用 `roughTokenCountEstimationForMessage`（≈字符/4）累加进 `estimatedTokensFromMessages`；遇 `system/compact_boundary`（:466-471）才清零累加器+latestUsage。
3. `totalTokens = min(max(contextBudget.usedTokens, providerTokens + estimatedTokensAfterUsage), rawMaxTokens)`（:2971-2980），`percentage = round(totalTokens/rawMaxTokens*100)`（:2981）。

**三条不收敛机理（全部 live 实证，本会话即实验对象）**：
1. **本地累加器远超真实窗口**：自上一个 `compact_boundary` 后，本会话 2869 条消息的本地 rough 累加=**~787K token=340% 的 231248 窗口**；而引擎真实 usage（input 2565+cache_read 84672+output 5608=**~92K=40%**）。显示取 max → 本地项钉死 100%。
2. **bc 压缩不写 compact_boundary**：bc 的 salvage/压缩发生在中间件层，回传的 assistant 消息照常追加进 transcript；sidecar 侧 376 个 compact_boundary 全来自 **sidecar 自己的 auto-compact**（`autoCompactIfNeeded`→`compactConversation`，`src/utils/messages.ts:4767` 写 boundary）。bc 压缩本身对 sidecar 零信号（bc bundle grep 无 compact_boundary 输出）。
3. **窗口口径错配**：ZXSV-AI provider 配 `modelContextWindows={'zxsv-ai':231248}`+`autoCompactWindow=231248`（226K），但 bc 实际管理的是引擎 ~1M+ 窗口+自己的收敛门控（bc §1.35/§1.36 growth36000/N=12）。denominator 是 sidecar 自设值，与 bc 真实预算无关。

**关键对照**（为何 auto-compact 自身行为正常但显示不收敛）：`shouldAutoCompact`（autoCompact.ts:212）用 `tokenCountWithEstimation`（tokens.ts:299）锚定**内存中最后一条真实 usage**（usage 锚 + 其后 rough 累加，锚含 cache_read → ~92K < 阈值 218K → 不误触发）；而显示路径用 `estimatedTokensFromMessages`=**全量自 boundary 累加（无 usage 锚）**。同一份数据、两个口径 → auto-compact 正常、显示钉 100%。

**live 交叉验证**：dev 7788 短会话 inspection 回 `percentage=19 totalTokens=43053/231248 apiUsage={input 1482, cache_read 41472}`=引擎真实值，口径正确；长会话（本会话）必被本地累加项顶到 100%。

### 方案（实施时定夺，倾向 A+B）

- **A（治本，推荐）**：显示口径对齐 auto-compact——`buildTranscriptContextEstimate` 的 `estimatedTokens` 改用 usage 锚口径（最后一条真实 usage 的 prompt 总量 + 其后 rough 累加），而非全量 `estimatedTokensFromMessages`。单点改 sessionService（复用 tokens.ts 已有 `tokenCountWithEstimation` 思路），bc 压缩后 usage 回落 → 百分比收敛。风险=低（显示只读路径，不碰压缩触发）。
- **B（兜底）**：bc 压缩/salvage 时让 sidecar 感知——两路：①bc 在流里发 compaction 标记（需 bc 协议扩展，改动大）；②sidecar 检测到「latestUsage 总量较前值骤降 > 阈值」时视为压缩事件，清零 `estimatedTokensFromMessages`（本地启发式，无 bc 改动）。
- **C（口径修正，可选）**：ZXSV-AI 窗口 231248 → 与 bc 真实管理窗口对齐（或留 231248 当「sidecar 自主 compact 预算」语义，文档说明）。

### 实施（commit 94c8f0f7，4 文件 74 行，方案 A 治本 + 伴随加固）

- **核心（方案 A）**：`src/server/services/sessionService.ts:2970` `buildTranscriptContextEstimate` 的 `totalTokens` 从 `min(max(contextBudget.usedTokens, providerTokens+estimatedTokensAfterUsage), rawMaxTokens)` 改为 `min(providerTokens+estimatedTokensAfterUsage, rawMaxTokens)`——显示总量走 **usage 锚口径**（最后一条真实 usage 总量 + 其后 rough 累加），与 auto-compact 的 `tokenCountWithEstimation`（tokens.ts:299）同口径。bc 中间件压缩后 usage 回落 → 显示百分比收敛，不再被自 boundary 的全量 rough 累加（本会话 ~787K=340% 窗口）钉死 100%。`estimatedTokens` 仍保留全量 rough 口径供 `calculateContextBudget` 的媒体信任启发式使用；低信任+媒体的可疑 usage 尖峰仍走 `ignoredUsageReason` 分支（行为不变）。
- **伴随加固**：`src/server/services/localIndex/sessionProjector.ts`——malformed transcript 会把 thinking 文本误解析进 tool_use name，原单字符串 metadata 上限 4KB 过紧（实测 12KB 异常值致 `LOCAL_INDEX_SOURCE_LIMIT`），放宽为 `MAX_PROJECTION_METADATA_VALUE_BYTES=16KB`（且由 `value.length` 字符判定改为 `Buffer.byteLength` 字节判定，多字节字符更准）；metadata 总量上限 `MAX_PROJECTION_METADATA_BYTES` 16MB→32MB。
- **回归测试**：`src/server/__tests__/conversations.test.ts` 新增「全量 rough 累加(150k)≫真实 usage(1200) 时显示锚定 usage」用例（600000 字符 assistant 消息 + usage 1200，断言 totalTokens=1200/percentage=1/rawMaxTokens=200000）——stash 旧码验证该用例 fail，正确钉住本改动。`sessionProjector.test.ts` 适配新上限常量。

### 验证

- src/server 相关 4 测试家族（conversations/sessions/contextBudget/sessionProjector 等）共 **488/488 绿**（加新回归测试后）；新用例在新码 pass、stash 旧码 fail。
- typecheck 干净（scoped，仅既有 TS5102 baseUrl 无关告警）。
- **22 链全验证**：068b3ebd 基线顺序 apply 22 patch（含新 `context-usage-anchor.patch`）FAIL=0，章十九 4 文件逐字节=工作树。

### 状态

✅ 已实施（2026-09-26，方案 A + projector 加固，patch `context-usage-anchor.patch` 入库）。


---

## 二十、H5 远端 API 响应 gzip 压缩传输（非本机默认开启）（✅ 2026-09-26）

### 需求背景（用户 2026-09-26 verbatim）

「通过H5访问，似乎会发送全量消息记录，那么通过发送压缩解压全量消息记录的方式似乎更佳，轮询判定访问来源ip非本机持有的时候，默认开启压缩传输机制。既能节省带宽，又能提速。先做仔细严格的调研分析可行性。」

### 调研结论（live 实测，全部硬数据）

- **前提坐实**：H5 打开会话 = 客户端 `getFullHistory`（`desktop/src/api/sessions.ts:446`）先 `mode=full` 后逐页 cursor 循环拉**全量**历史。生产 37206 条会话（jsonl 193MB）实测 wire=**139MB / 701 页 / 25.9s（loopback）**。
- **无现成压缩**：`Bun.serve` 无 compression 选项，全仓无 content-encoding 中间件（proxy/ 除外）。
- **压缩比**：同 payload 实测 gzip ≈3.0x、brotli(q4) ≈6.0x（Bun 1.3.14 走 node:zlib，无 Bun.Gzip 全局 API）。选 gzip（兼容性优先，浏览器 fetch 原生透明解压）。
- **客户端零改动**：浏览器 `fetch` 按 HTTP 规范透明解压 gzip，`res.text()`/`res.json()` 拿到明文 JSON；`readJsonBody` 的 `MAX_JSON_RESPONSE_BYTES=530MB` 门槛按解压后明文算（136MB 不过）。
- **IP 判定**：复用 `server.requestIP(req)?.address`（`index.ts:309`）+ `isLoopbackHost`（h5AccessPolicy.ts:41）——非 loopback 默认压缩，本机桌面路径零影响（用户要「轮询判定」，实际每请求实时判定，更强）。

### 实施（commit 26375d8f，3 文件 246 行）

- `src/server/responseCompression.ts`（新）：`shouldGzipResponse`（门控）+ `withGzipIfEligible`（压缩）。门控=仅 GET 200 + `Accept-Encoding` 含 gzip + **非 loopback** + content-type json + >128KB（`MIN_COMPRESS_BYTES`；Response.json 不保证 content-length，权威判定在 arrayBuffer 读取后）。`gzipSync level 6`。env 开关 `CC_HAHA_TRANSPORT_GZIP=0` 关 / `=1` 强制 loopback 也压（测试用）。前 5 次压缩打一条日志（MB→MB + 倍数）。
- `src/server/index.ts`：`/api` 分支一行接线 `withCors(await withGzipIfEligible(req, response, clientAddress), cors)`。
- 单测 `responseCompression.test.ts`：10 例（门控/透明性/loopback/小 payload/env 开关）。

### 验证（dev 7788 E2E，LAN IP 192.168.10.43 触发压缩 vs 127.0.0.1 基线，同一大会话）

- wire **136.19MB → 43.09MB（-68%）**；解压后**逐字节一致**（27984 条 / 705 页全对齐）。
- 705 页中 485 页压缩，<128KB 小页正确透传；loopback `gz_pages=0` 桌面零影响。
- 耗时 loopback 口径仅 -7%（本机瓶颈=服务端分页读盘+JSON 序列化，非传输；移动网络弱网收益=带宽为主）。
- typecheck 干净；server 全量 **3442 pass / 0 fail**（178 文件，#83 基线标准）。

### 踩坑记录

1. **arrayBuffer 耗 body 后回退返回原 Response → 空 200**：`response.arrayBuffer()` 消耗 body 后，「太小不压/压不小」两条回退路径若仍 `return response`，客户端收到 200+空 body（705 页 walk 在第 18 页抓出，3 次复现全中）。修=回退一律 `new Response(raw, {status, headers})` 重建。
2. **Bun 的 `Response.text()` 不像浏览器透明解压**：单测若直接 `out.text()` 拿 gzip 字节 JSON.parse 失败（Bun 忠实于"body 原始字节"）；真实浏览器 fetch 按规范解压→生产无碍，单测须手动 `gunzipSync` 模拟客户端视角。
3. **Bun 1.3.x 无 `Bun.Gzip`/`Bun.BrotliCompressStream` 全局 API**（typeof undefined）；`node:zlib` 的 gzipSync/gunzipSync/brotliCompressSync 全部可用，流式 `createGzip` 管道也通。

### 状态

✅ 已完成并提交（2026-09-26，commit 26375d8f）；patch `patches/h5-gzip-transport.patch`（3 文件 277 行，基线 d6767a02）。

---

## 二十一、思考计时与工具计时综合优化：思考 token 用量/耗时 + 收纳栏总计时 + 收纳栏 token 用量（✅ 2026-09-26）

### 需求背景（用户 2026-09-26 verbatim，多次递进）

1. 「新增一项优化项，作为待办事项，暂不推进。记录每次思考耗时，并在对话记录里体现，类似工具执行耗时在横条右端末尾记录耗时。」
2. 「新增的第二十一项优化项，更改为记录思考消耗 token 用量和耗时，think 横条右侧末尾显示 xx.xk 小数点两位多少 k 的 token 消耗，xs/xmxs/xhxm 多少秒/几分几秒/几小时几分不带秒。」
3. 「think 不同于工具，工具一般很快就执行完成，所以 think 要从一开始就持续展示耗时。我觉得应该以 server 收到 think 字段开始的时间做记录，然后每隔 3 秒刷新一次。think 完成后的计时采用结束时间减去开始时间予以固定。」
4. 「思考完成后，把『思考+工具收纳栏』（ActivityGroup 摘要行）的计时也改成『思考+工具总计时』；收纳栏 token 统计里『工具』部分按结果内容估算。」

→ 本章范围综合为三块：**①单条思考 badge（token+耗时，实时 3s 刷新）②收纳栏总计时（分段求和）③收纳栏 token 用量（思考+工具）**。

### 展示规格（定稿）

- **单条思考 badge**=思考横条（ThinkingBlock）右侧末尾，与工具执行耗时同款 mono tabular-nums 样式；
  - **token 用量格式**=`xx.xk`，保留两位小数（例 `1.23k`、`12.50k`）；
  - **耗时格式**=三档阶梯：`<60s`→`12.3s`（一位小数秒）；`60s~1h`→`3m05s`（整分+补零秒，不带小数）；`≥1h`→`2h05m`（不带秒）；
  - **实时性**：进行中从「server 收到 think 块起点」开始计时，每 3s 刷新；结束后固定为结束−开始；
- **收纳栏（ActivityGroup 摘要行）**：
  - **总计时**=分段求和（Σ思考耗时 + Σ工具执行耗时），替代原墙钟跨度；
  - **token 用量**=思考内容估算 + 工具结果内容估算；估算口径显示 `思考Xk + 工具Yk`（思考在前、`+` 分隔），真实回传口径显示合并总数。

### 实施（2026-09-26，19 文件，526 增/51 删）

**① 计时数据链路（SDK→WS→客户端）**

- `src/services/api/claude.ts`：`content_block_start(thinking)` 时按 block index 记 `thinkingStartedAtByIndex`；thinking 块生成完毕落 transcript 行时算 `thinkingDurationMs` 并写入 assistant 消息 meta（持久化，重开会话可回显）；
- `src/server/ws/streamBlocks.ts` + `handler.ts`：`thinkingBlockStarts` Map 记录每开块 `content_block_start` 时刻（比首个 delta 更早、更准，差 <100ms）；`thinking_delta` 事件携带 `serverStart`（每 delta 都带，幂等）；`content_block_stop` 清理；
- `src/server/ws/events.ts` + `desktop/src/types/chat.ts`：`ServerMessage/AgentRunStreamMessage` 的 `thinking` 事件加 `serverStart?`；
- `src/server/services/sessionService.ts`：`MessageEntry.thinkingDurationMs` 透传（history 回放路径）；

**② 客户端 settle + 渲染**

- `chatStore.ts`：`settleThinkingDurations()`——`activeThinkingId` 清空点（text/tool_use block_start、message_complete 两处、api_retry）把 `now - timestamp` 盖到 `thinkingDurationMs`；历史映射 `pushAssistantHistoryThinking` 从 transcript 取 `thinkingDurationMs`（前缀增长取新值、相邻块合并求和）；
- `ThinkingBlock.tsx`：`thinkingBadgeLabel()`/`formatThinkingTokens()`/`formatThinkingDuration()` 纯函数 + 3s `setInterval` 实时 tick（锚定 `serverStart`，非客户端接收时刻）；
- **无耗时记录的已结束块**（旧会话历史回放）badge 单显 token `xx.xk`（不拼 `· xs`），避免整条消失——这是 H5「token 显示没了」的修复点；
- `ActivityGroup.tsx` + `activityGroupModel.ts`：`activityDurationMs` 改分段求和（纯思考回合、以思考结尾的回合原口径不显示/少算）；新增 `activityTokenUsage()`（`estimateTokens` 思考内容 + `extractTextContent` 工具结果）与 `activityTokenLabel()`（估算→`Xk + Yk`，真实→合并总数）；

**③ 测试（40 条新增/更新，全绿）**

- ThinkingBlock 22 例（badge 实时 tick/结束固定/无锚点隐藏/无耗时长单显 token/三档格式函数）；
- ActivityGroup 16 例（分段求和、尾思考计入、token 标签两段/单值）；
- chatStore `settleThinkingDurations` 4 例（盖值、不覆盖已 settle、负跨度 clamp 0、无变化返回同引用）；
- server 侧 golden/ws-memory/agentRunMessage 适配 `serverStart` 透传。

### 验证

- tsc 0 错；前端相关家族 444/444 绿（ThinkingBlock 22 + ActivityGroup 16 + chatBlocks 44 + chatStore 354 + tpsMeter 8）；server 3 测试家族 65/65 绿。
- **H5 实测坑**：H5 服务 `desktop/dist`（`CLAUDE_H5_DIST_DIR`），服务端改动 bun sidecar 直跑源码即生效，但前端渲染必须重新 `vite build`——15:49 旧 dist 无 badge 代码，H5 思考行 token 消失即此因；重构建后 `data-thinking-usage` 入新 App chunk，H5 handler 每请求读盘无需重启。

### 踩坑记录

1. **H5 与桌面共用 `desktop/dist`**：服务端（bun 跑源码）改了立即生效、前端（静态 bundle）必须重建，两者节奏不同步会让 H5 看起来"改了没生效"。
2. **无耗时记录的旧会话**：`thinkingDurationMs === undefined` 时原实现直接返回空 badge——历史会话整条消失；修为单显 token。
3. **分段求和 vs 墙钟跨度**：旧 `activityDurationMs` 用首步→末结果跨度，含空闲间隙且纯思考/尾思考回合无"终点"；改 Σ分段后「以思考结尾」的回合也正确显示。
4. **`serverStart` 锚点选 `content_block_start` 而非首个 delta**：更早（比 delta 早 <100ms）且必然存在；每 delta 重复携带保证幂等（delta 可能丢/重放）。
5. **settle 点必须覆盖全部 `activeThinkingId` 清空路径**：text/tool_use 的 block_start、message_complete、api_retry 三处，漏一处该思考块永远停在实时 tick。

### 子优化① （2026-09-27）：收纳栏顺序 + `+` 间隔 + 零耗时按未测处理

**用户指示（verbatim）**

> 1、收纳栏右侧，应该先显示 token用量 再显示所耗时间，+号间隔两个token用量的留白间隔不能太大也不能太小 需要比当前的间隔小些。
> 2、think内容现在有token量但是没有所耗时间，需要处理。
> 老think没有耗时，这个也需要处理，老历史记录没有耗时可以跳过。

**① 收纳栏右侧顺序 + `+` 间隔**（`ActivityGroup.tsx`、`activityGroupModel.ts`）

- 原来是 **耗时在前、token 在后** → 改为 **token 在前、耗时在后**（用户要求）；
- `+` 间隔：原实现把两段拼成一个字符串 `"0.40k + 0.00k"`，而标签渲染在 **monospace 字体**下 —— 等宽字体里一个空格就是**固定一个字符宽**，无法压到「介于 0 和 1 个空格之间」。故拆为结构化渲染：
  - 新增 `activityTokenParts(usage): string[]`（返回各段），渲染层用 `flex gap-[3px]` 控制间隔；
  - `activityTokenLabel()` 保留为 `parts.join(' + ')` 的字符串形式（测试/回退用），**不改既有签名**。

**② 零耗时按「未测」处理**（`ThinkingBlock.tsx`、`claude.ts`）

- 排查发现：**正常路径**耗时有值（锚点在 `content_block_start` 写入，`claude.ts:2420`）；但**缺锚点**时原代码写 `thinkingDurationMs: 0`：
  ```ts
  typeof startedAt === "number" ? Math.max(0, Date.now() - startedAt) : 0
  ```
  → 客户端 `formatThinkingDuration(0)` = `0.0s` → 显示成 **`1.23k · 0.0s`**，**看起来像测过了，其实没测**。
- 两端同时修：
  - **服务端**：缺锚点 → **不写该字段**（`return {}`），与「字段缺失 = 未测」的既有契约一致；
  - **客户端**：`thinkingDurationMs === undefined || <= 0` 一律按未测处理 → 只显示 token。既覆盖新逻辑，也兼容**已落盘的旧 0 值**。
- 「老历史记录没有耗时」→ 正是既有回退（token-only），已符合，无需额外处理。

**③ 顺带坐实「为什么看起来一直没生效」**

用真实 transcript 实测：`3a86698f` 412 个 thinking 块、`4e1f6c0c` 480 个，**带 `thinkingDurationMs` 的均为 0 条**。时间线对比：

| 事件 | 时间 |
|---|---|
| sidecar（PID 7142）启动 | **15:52:28** |
| `claude.ts` 最后修改 | **20:04:34** |
| 章二十一提交 | 22:42:18 |

⇒ **运行中的进程比该功能早约 4 小时**，写出的 transcript 从未产出该字段。前端产物（`desktop/dist`）已于 22:43 重建、含新代码。**重启后新思考块才会带耗时**；旧记录按设计只显示 token。

**验证**：`ThinkingBlock` 23/23、`ActivityGroup` 16/16、前端 chat 家族 **1246/1246**（47 文件）、服务端 api **244/244**、desktop `tsc --noEmit` **EXIT=0**、eslint **EXIT=0**。

### 子优化② （2026-09-27）：轮次用量（每轮总消耗 token）

**用户指示（verbatim）**

> 上面这个是每轮正文下面的附带信息。需要增加一个每轮总消耗 token 量
> `复制 分享 9月27日 00:57 · 耗时 12 秒` → `复制 分享 9月27日 00:57 · 用量1K 耗时 12 秒`
> 这个总 token 用量为每轮内总量，think 不回传则不纳入 think 用量
> 同样也要考虑到避免挤兑式大量爆发计算和无意义的计算浪费性能。

（原「第二十五章」登记项，按要求并入本章。）

**口径裁决：取 (a) 真实 `output_tokens`**

| 候选 | 取舍 |
|---|---|
| **(a) 真实 `output_tokens`（API 回传，`usageKey` 去重）** | ✅ **采用**：thinking 已含在 output 内；provider 不回传 thinking 时该部分自然不计入，**恰好落实「think 不回传则不纳入」**；数字真实非估算 |
| (b) `output + input`（不含缓存命中） | ✗ 每轮 input 含全部上下文，量级远超用户示例的「1K」 |
| (c) 与收纳栏同源的内容估算 | ✗ 属估算值，且须遍历内容——正是本章已认定的「贵」路径 |

**展示规格**：页脚 `复制 分享 · <时钟> · 用量<X> · 耗时 <Y>`（**用量在耗时之前**，与子优化①一致）。

**性能设计（落实用户「避免挤兑/无意义计算」要求）**

关键区分：**耗时/用量都不在渲染路径上做昂贵计算**。

- 用量是**已落在 transcript 里的真实数字**（服务端 `sessionService` 归一化后连 `usageKey` 一起下发），读取即用，**零估算**；
- 计算量仅是**把这一轮已有的两个字段相加**（`output_tokens` 求和 + `Set` 去重），与既有轮次分组**同一趟遍历**完成，**不新增遍历**；
- 反例（未采用）：若按候选 (c) 走 `estimateTokens()`（逐字符 + 每字符两次正则、无缓存），才会在渲染路径上产生本章 `### 性能设计` 里点名的那类浪费。取 (a) 即从根上避开。

**实施（5 文件）**

| 文件 | 改动 |
|---|---|
| `desktop/src/types/chat.ts` | UIMessage 的 `assistant_text`/`thinking`/`tool_use` 三个变体加 `usage`/`usageKey`；`types/session.ts` 的 `MessageUsage` 直接复用作行上类型（无循环依赖） |
| `desktop/src/lib/turnCompletion.ts` | `TurnCompletion` 加 `outputTokens?`；`OpenTurn` 加 `outputTokens`/`hasReportedUsage`/`countedUsageKeys`；**在既有 for 循环内**按 `usageKey` 去重累加 |
| `desktop/src/stores/chatStore.ts` | 历史映射 `stampResponseUsage()`：把该次调用的 `usage` 盖到它产出的那些行上 |
| `desktop/src/components/chat/TurnCompletionStamp.tsx` | 渲染 `chat.turnUsage`，位于耗时之前；`outputTokens` 缺失或 0 时不渲染 |
| `desktop/src/i18n/locales/*.ts` | 新增 `chat.turnUsage`（en/zh/jp/kr/zh-TW） |

**关键设计点**

1. **一轮 = 多次 API 调用，故求和而非取单值**：一轮是「模型调用→工具→再调用」，每次调用各带一份 `usage`，轮次总量是它们的和（测试用例覆盖：400 + 600 = 1000）。
2. **`usageKey` 不可省**：一条回复在 transcript 里写成十来行、**每行重复整份 `usage`**，逐行累加会膨胀 2.2 倍（与 `summarizeTokenUsageFromHistory` 既有结论一致）。同一次调用的所有行共用一个 key，整轮去重。
3. **无 key 的行照计**：与既有 `summarizeTokenUsageFromHistory` 口径一致（没有 message id 可依的行本就不是重复行）。
4. **`0` 视为「未自报」而非「用了 0」**：不产出 `outputTokens` 字段 → 页脚不显示用量，而不是显示一个自信的 `0.00k`（与子优化①「零耗时按未测」同一原则）。
5. **行未新增时的兜底**：历史映射会把相邻思考块并成一行、把正文前缀增长并进上一行（`pushAssistantHistoryThinking`/`pushAssistantHistoryText`），此时该次调用**不产生新行**。`stampResponseUsage` 在两个方向各扫一遍（新行 → 无则向前吸收行），保证用量落在吸收它的那一行上而不是丢弃。

**验证**：`turnCompletion` 19/19（含 6 条用量用例）、`TurnCompletionStamp` 8/8（含顺序与缺失）、`locale` 7/7（5 语言键对齐）、`chatStore` **360/360**（含 6 条映射用例）；`components/chat`+`lib`+`i18n` 家族 **1763/1763**；desktop `tsc --noEmit` 与 `eslint` 均 exit 0。

**踩坑记录**

6. **`usage` 来源：transcript 顶层没有，在嵌套 `message.usage` 里**：直接扫 `*.jsonl` 的 `type==='assistant'` 行查 `usage` 会得到 0 命中（实测 13097 行全无）。服务端 `sessionService.ts:1872` 从 `msg.usage` 取值、`normalizeMessageUsage()` 归一化后才下发到 `MessageEntry.usage`——客户端拿到的一直是**服务端盖章后**的形态。
7. **轮次分组模型只认 `UIMessage`，不认 `MessageEntry`**：`buildTurnCompletionByMessageId(messages: UIMessage[])` 的边界是 `user_text → 下一条 user_text`，而 `usage` 原本只在 `MessageEntry` 上。故必须先把用量送进 `UIMessage`（改动 1），聚合才有输入——这是本项最小改动的关键路径。
8. **不要为用量新起一遍遍历**：`turnCompletion.ts` 的 for 循环本就逐条走该轮全部消息，用量累加挂进同一循环即可；另起一次 `messages.filter(...)` 属无谓开销。
9. **回退盖上用量必须设界，否则会抹掉另一次调用的数字**：初版 `stampResponseUsage` 的兜底是「新行一个都没盖到就往前找最近一行盖上」。但「一行都没产出」还有一种成因——本次调用**自己的行被并进了上一行**，而上一行可能是**另一次调用**的行（它自带 `usage`/`usageKey`）。此时无条件覆盖会把那次调用的用量抹掉，比丢掉本次更糟（脏数据 vs 少算）。修法：`stamp` 内**拒绝覆盖已带 `usage` 的行**；回退循环**遇到最近一行助手内容就停**（不继续往前找），并在**用户消息**处硬停，不跨轮次。两条边界各有一条测试（`never back-fills a row that already belongs to another call` / `does not back-fill across the turn boundary`）。
10. **TS 联合收窄不能拆成返回布尔的辅助函数**：把 `message.type === 'assistant_text' || ...` 抽成 `isAssistantRow(index): boolean` 后，TS 无法把 `UIMessage` 联合收窄到「可赋值 `usage` 的那三个变体」，报 TS2322/TS2339。收窄必须**内联在赋值处**（用提前 return 的卫语句），与初版 `stamp` 闭包写法一致。

### 状态

✅ 已实施（2026-09-26，子优化① 2026-09-27，子优化② 2026-09-27）；patch `patches/thinking-tool-timing.patch`（第 23 位）+ `patches/thinking-badge-order-and-duration.patch`（第 30 位）+ `patches/turn-usage.patch`（第 31 位）。

### 子优化③ 补录 golden 夹具（2026-09-27，修既有回归）

- **现象**：`desktop/src/stores/chatStore.golden.test.ts` **2 条失败**（`thinking-then-text` 与「is independent of session id and replay order」），断言为思考消息多出 `thinkingDurationMs`。**在干净 HEAD `4fbaaad6` 上同样失败** → 自 #91（`ef8801e3`）引入该字段起就坏了，与同日其它工作无关。
- **根因**：golden 夹具 `__fixtures__/chat-store.golden.json` **没有跟着重录**。该测试的设计口径本来就是「锁定时钟后重录」（见测试头部注释：`FIXED_NOW` 把非确定性从源头掐掉，字段计算方式一变就应在 diff 里显形），所以新字段必须重录进夹具，而不是在比较时把它 normalize 掉。
- **修法**：`UPDATE_CHAT_STORE_GOLDEN=1` 重录夹具 → 3 处新增 `thinkingDurationMs: 51`。**51ms 是确定值**（= 回放脚本推进的时长，不是真实耗时），已用「重录幂等」二次验证。
- **踩坑记录**：
  1. **夹具型测试新增字段后必须重录**，否则「改了计算却忘了记录」会让测试红着进基线；本章第 ①/② 子优化当时都漏了这一步。
  2. **重录值必须验确定性**：时序字段若取自未被固定的时钟（如 `performance.now()`），重录会得到随机值、下次仍红。本次为 `Date.now()`+固定时钟，故 51 是常量；验法=连录两次比对无差异。
  3. **夹具文件此前不在任何 patch 覆盖内** → 重放 patch 链得到的是**红树**。本次把夹具 section 并入引入该字段的 `thinking-tool-timing.patch`（链位 23，**1052 → 1086 行**），使链终态 golden 转绿（已在链终态实测 14/14）。

### 子优化④ 子代理耗时 + 后台任务耗时并入本章（2026-09-27）

**需求（用户 verbatim）**：「给所有子代理也加上执行时间耗时，子代理收纳栏也加上总耗时统计。所有后台执行任务也加上执行时间耗时信息。子代理耗时+后台任务耗时一起并入 think 耗时优化项。」

**展示规格（用户逐字给定，含两轮修正——两个界面规格不同，别搞混）**：
1. **收纳栏汇总行**（`派遣了 N 个子代理 …`）：→ **`派遣了 N 个子代理 · 总耗时 xhxm/xmxs/xs · 进行中/已完成/已停止`**。**带中文标签、靠右**——用户 verbatim：「这个总收纳栏改为显示为"派遣了N个子代理…总耗时(靠右，中文标签)"毕竟这个总收纳栏，有充足的留白用于显示」。
2. **每条子代理行**（`agent 标题 + 第二行部分执行内容 … 查看结果 · 打开运行记录 … 开始中/进行中/完成 · 动作收纳按钮`）：→ 中间插入**裸数字** `xhxm/xmxs/xs`（**不带标签**）——用户 verbatim：「跟 think 和工具一样，只显示 xhxm/xmxs/xs 这种精简能表达意思的即可」。
3. 后台任务：activity 面板**行右侧**加耗时；**下拉展开的卡片里「使用量」详情行右侧**也加耗时。
4. **活动面板内的子代理行不加**（用户明确排除：点任意子代理直接进执行详情，且浮动卡片宽度不适合每行再加字段）。

> **一句话记法**：**有留白的地方带标签（汇总栏），没留白的地方只放数字（单行）**。首版把两处都做成带标签被退回；改成两处都裸数字后，汇总栏又被要求加回标签——最终是「按各自可用宽度分别定」。
>
> **标签与数字之间不用空格**（用户 verbatim：「中文和时间信息中间的间隔留白不要太大，稍微紧凑些」）。实现上 `toolGroup.agentTotalDuration` 只存标签本身（`总耗时`），数字是**独立元素**，两者由 `gap-[3px]` 的 flex 相连——比一个整空格窄，且字号/字距可单独控制。首版把数字塞进 i18n 模板（`总耗时 {duration}`）导致那个空格在大字号下像一个洞。

**数据来源与口径（关键设计）**：
- **汇总栏 = 区间并集跨度（wall-clock span），不是各子代理耗时之和**（用户 verbatim：「这总耗时，并不是每个子代理耗时直接做加法，否则你这耗时数据肯定不对。安排下去的子代理是**并行**而不是串行的，串行是可以直接相加为总，而并行应该是发起时间和结束时间中的真正耗时」）。首版 `agentGroupDurationMs` 直接 `+=` 各成员时长——**3 个并发 2 分钟的子代理会显示 6 分钟**，是错的。改为：
  - 每个 run 先求出**区间** `{startMs, endMs}`（`agentRunInterval`）：`startMs` = 父会话 Agent `tool_use` 的 timestamp；`endMs` = 有上报取 `startMs + usage.durationMs`，否则取 `tool_result.timestamp`（且要求 `end ≥ start`，否则判为不可测）。
  - 汇总 = `max(endMs) − min(startMs)`（`agentGroupSpanMs`），即**最早发起 → 最晚结束**的真跨度。
  - 单个行的数字仍取**该 run 自身长度** `endMs − startMs`（单行要的是这一个 run 的耗时，不是组跨度）。
- **为什么不能复用本章 `activityDurationMs` 的求和**：那里的步骤（一次思考、一次工具调用）**确实是串行**发生的，求和才对；而派发出去的一组子代理**确实并发**，只能取跨度。**同一个"收纳栏总耗时"，两种拓扑两种算法**——这是本次最容易被想当然搞错的地方。
- **数字格式 = 工具耗时徽章同款 `formatDuration`**（`ToolCallBlock`，与工具行上的 `524ms` 同一个函数）：`420ms` / `1.5s` / `42s` / `5m12s` / `1h30m`——紧凑、无空格。汇总栏额外套 `toolGroup.agentTotalDuration` 标签（5 语言，**纯标签、无占位符**）。
- **activity 面板行/详情**用面板自身既有 `formatBackgroundDuration`（`chat.duration.*`，输出 `1m 7s`）——这是该面板**原有的耗时口径**（详情行的使用量早已在用），换掉会让面板自相矛盾。
- **后台任务的 start 锚点**：`AgentTaskNotification` 只报 `duration_ms` 不报起点，故区间取「该 Agent 工具调用被发起」的时刻为起点。对后台 run 这是**近似**（发起与真正开始执行几乎同时）；同步 run 不需要此近似（两端都是真实时间戳）。

**⚠️ 已知边界（如实登记）**：后台子代理的区间起点用「发起时刻」近似，因此**若同一组里既有后台又有同步 run，跨度可能比真实略长或略短**（后台 run 的真实起跑可能晚于发起几毫秒~几十毫秒）。在「最晚结束 − 最早发起」的口径下这点误差相对整组跨度可忽略；但**不要**把它当作精确的并发时间线。
- **后台任务耗时早就有**：`usage.duration_ms` 由 CLI 经 `task_progress` / `task_notification` 上报 → `chatStore.normalizeBackgroundTaskUsage` 落到 `BackgroundAgentTask.usage.durationMs`。本次只是**把它显示出来**（此前只在转录卡片和 activity 详情里露出）。
- **异步子代理**耗时同源（同一条 task 事件链），本次在行上显示。
- **同步子代理**耗时=**父会话 Agent `tool_use` → `tool_result` 时间戳差**（与既有 `toolCallDurationMs` 同一口径，与「工具耗时」一致）。用户选定此口径。
- **优先级**：运行时上报值优先，拿不到才回退时间戳推算。理由：**后台代理启动即返回**，时间戳跨度≈0 而实跑数分钟——那里上报值是唯一真值；同步代理阻塞其工具调用，时间戳差就是该 run 的墙钟。
- **未settled 的同步 run 不显示数字**：既无上报值、又无结果时间戳，没有任何可信锚点，宁可不显示也不猜（避免"0s"这类谎话）。汇总行同理——只有可测成员贡献数字，全不可测则整条标签不渲染。

**落点**：
| 文件 | 改动 |
|---|---|
| `desktop/src/components/chat/activityGroupModel.ts` | 新增 `agentRunInterval`（求每个 run 的 `{startMs,endMs}`，上报优先→时间戳回退）、`agentRunDurationMs`（单行用）、`agentGroupSpanMs`（**区间并集跨度，非求和**；全不可测返回 `undefined`） |
| `desktop/src/components/chat/ToolCallGroup.tsx` | `AgentToolGroup` 汇总行（`data-agent-group-duration`，**带 `总耗时` 标签、靠右**）、`AgentCallCard` 单行（`data-agent-call-duration`，**裸数字**）各插一个耗时 span，数字格式取自 `formatDuration` |
| `desktop/src/components/activity/SessionActivityPanel.tsx` | `ActivityRowView` 行右侧耗时（`data-activity-duration`，仅 `tasks`/`backgroundTasks`）；`BackgroundTaskDetail` 使用量行右侧耗时（`data-activity-detail-duration`） |
| `desktop/src/i18n/locales/*.ts` | 新增 `toolGroup.agentTotalDuration`（5 语言，**仅供汇总行**） |

**踩坑记录**：
1. **全 Agent 的 run 根本进不了 `ActivityGroup`**：`ToolCallGroup` 有短路——一组全是 Agent 调用时直接走 `AgentToolGroup`，`ActivityGroup` 永远看不到它们。所以「收纳栏总耗时」**不能**复用本章既有的 `activityDurationMs`（它基于 `ActivityStep`，union 只有 `thinking | tool`），必须另写 `agentGroupDurationMs`，否则改半天看不到效果。
2. **子代理行默认折叠**：`AgentCallCard` 只在整个组展开时才挂载。补测试时先断言行内的耗时 span 会**取到空数组**——必须先 `fireEvent.click` 汇总行。这不是 bug，是折叠设计的必然。
3. **同一数字在一张卡里出现两次是刻意的**：后台任务耗时既在折叠行、也在展开详情的「使用量」行右侧。首版以为重复是失误，其实「折叠态一眼可见 + 展开态与 token 并列」是两个不同用途；测试相应断言 `getAllByText('1m 7s')` 长度为 **2**。
4. **耗时不能塞进「使用量」字符串**：原来 `格式为 94.3k tokens · 1m 7s`，耗时被埋在计数之后。抽出成**独立的右对齐槽位**（`justify-between`）——读者是来扫这个数的，不该让他先穿过 token 数。此改动已同步既有断言（原 `getByText('94.3k tokens · 1m 7s')` 拆成两处）。
5. **`0` 不是测量值**：`agentCallDurationMs` 对 `0` 的上报值不认（回退时间戳），与本章子优化①「零耗时按未测处理」同一原则——避免 `0s` 这个假数字。

**验证**：`ActivityGroup.test`（6 条：上报优先且按发起时刻定位区间／时间戳回退且 `0` 不算测量／未 settle 与 `end<start` 都判不可测／**并发三 run 取跨度 121s 且显式断言 ≠ 求和 361.5s**／部分重叠取并集／含不可测成员与全不可测）、**新建** `ToolCallGroup.test`（4 条端到端：两代理错开 199s 发起 → 汇总行**跨度** `8m19s`（并断言 ≠ 串行和 `7m0s`）、逐行**裸** `2m0s`/`5m0s`；后台代理按上报 `3m0s`；进行中同步代理两处都不显示；**同时发起的两 run 汇总 = 单个 `2m0s` 而非 `4m0s`**）、`SessionActivityPanel.test`（更新详情断言并新增行/详情的 `data-*` 锚点）、`i18n` 用例。桌面 `tsc --noEmit` 0 错。

**踩坑记录（补）**：
6. **端到端用例不能落在 `MessageList.test.tsx`**：该文件带一处**已登记的非章 delta**（虚拟化用例的 flaky 超时放宽，见文末「已知非章 delta」，**有意不入任何 patch**）。把新用例写进去，会让链位补丁被迫连同那处放宽一起收编，破坏「该 delta 不进链」的既定边界。改为**新建 `ToolCallGroup.test.tsx`** 直接渲染 `ToolCallGroup`（它是 export 的，`toolCalls`/`resultMap`/`agentTaskNotifications` 均可注入）——比穿过整个 `MessageList` 更聚焦，也保住了边界。
9. **并行 ≠ 串行，总耗时不能相加**（最严重的一个错，被用户当场纠正）：首版把汇总栏实现成「各子代理耗时求和」。子代理是**并发派发**的，3 个并发 2 分钟会显示 6 分钟。正确做法是取**区间并集跨度**（最早发起→最晚结束）。**判定口诀：步骤在时间轴上串行发生 → 求和（如本章 `activityDurationMs` 的思考+工具）；一组任务并发派发 → 取跨度（如本子优化④的子代理组）。** 两者都叫「总耗时」，算法完全不同。
10. **单行数字与汇总数字口径不同是有意的**：单个子代理行显示**该 run 自己的长度**（`end−start`），汇总栏显示**整组跨度**。若两者都用跨度，单行会显示「从第一个开始到最后一个结束」，读起来像这个 run 跑了那么久。
11. **别自作主张加单位/标签，但也要分清哪里该加**：首版给**两处**数字都套了中文标签，被退回「不是让你把中文也加进去，而是跟 think 和工具一样，只显示 xhxm/xmxs/xs」；两处都改成裸数字后，汇总栏又被要求加回标签——「毕竟这个总收纳栏，有充足的留白用于显示」。**教训：判断依据不是"要不要标签"，而是"这一行有没有留白"**：汇总行有 `flex-1` 让出的空间，带标签更好读；单条子代理行右侧已挤着「查看结果 / 打开运行记录 / 状态 / 折叠」四个元素，再加标签就吃掉标题的宽度。两次修正都不是矛盾，是把同一个原则用到了两个宽度不同的地方。
8. **格式函数要挑对**：`formatDurationMs`（`lib/backgroundTasks.ts`）与工具徽章的 `formatDuration`（`ToolCallBlock`）输出**不同**——前者 `5m 12s`（带空格、走 i18n），后者 `5m12s`（紧凑、无 i18n）。转录区选了后者（与工具徽章同函数）；activity 面板保留前者（与该面板既有耗时口径一致）。同一功能里出现两种格式是**有意**的：各自跟随所在区域的既有约定。

---

## 二十二、历史记录膨胀（`toolUseResult.originalFile`）致大体积会话打不开（🔍 调研，2026-09-26）

> **完整调研报告另立**：`modify/reports/历史记录膨胀致大体积会话打不开-调研报告.md`
> 本节仅登记结论与去向，实施细节以报告为准。

### 需求背景

- 远端 H5 打开会话「优化小批量 GEMM 推理吞吐」（`db39b34d-420a-4151-a3a1-77e5d48635e4`）**一片空白、无任何历史消息**；本地桌面同样长时间无内容。
- 用户初步判断为「升级 0.6.6 后会话记录丢失」。

### 结论摘要

1. **数据未丢失**：文件 114.3 MB / 6891 行 / 坏行 **0**，索引在册，端点 `summary`/`messages`/`mode=full` 全 200——与「升级丢数据」无关。
2. **膨胀源**=`toolUseResult.originalFile`（Edit/Write 落盘的**改前整文件**）：本会话 20 条 >1MB 记录共 78.6 MB（占 66%），其中 `originalFile` 独占 **76.1 MB**；全局 518 个 transcript 共 **3.0 GB**。**且与 file-history 备份内容重复**（本会话 86 MB / 全局 550 MB，已有 `readBackupFileSafely` 可安全取回）。
3. **白屏真因（v2 修正）**：客户端首个 `mode=full` 请求撞 **120 s 超时**（诊断日志 `timed out after 120s` × **12**，含仅 13.6 MB 的 `4e1f6c0c`）→ 阻塞式 `await getFullHistory`（`chatStore.ts:2318`）永不 resolve → 不 apply → 白屏。**v1 的「翻完才渲染置空 messages」判断已证伪**（置空的是派生状态；时间线用 `uiMessages`）。体积是放大器：超预算记录独占一页 → 实测 152 页未完成。

### 优化方向（详见报告第七节）

| 序 | 层 | 做法 | 数据变更 |
|---|---|---|---|
| **A** | 读取层 | 主历史路径套有界 preview（`displayPreview` 同款） | 无 |
| **B** | 客户端层 | 首屏渐进渲染 + `projectContext:false` 绕开 context lane（cap=1 全文件重建）+ 超时兜底 | 无 |
| **C** | 写入层（根治） | 落盘收口（`cleanMessagesForLogging`）裁 `originalFile` 为有界预览 + 新增 `originalFileTruncated/Bytes/Ref` 键，**保留 `structuredPatch`** | 无（只影响新写入） |
| **D** | 读取层 | 新增按需端点：`file-history/content` → `readBackupFileSafely` 取回原文 | 无 |
| **E** | 存储层 | file-history `-completed-*` 去重/变动才建/版本上限（550 MB 冗余） | 无 |
| **F** | 写入层 | 落盘时对 `originalFile` 做 16KB 有界裁剪（+ 标记键） | ✅ 已实施（patch #33，2026-09-27） |
| **G** | 传输层 | gzip 改流式/异步；活跃会话历史缓存窗口化 | 无 |
| **H** | 读取预算 | `HISTORY_FULL_BYTES` **32 MB → 8 MB**（`boundedSessionHistory.ts:20`） | 无 |

### H 项说明（参数调参，本次仅入设计未改代码）

- **收益**：`mode=full` 单响应上限 32 MB → 8 MB，压掉内存尖峰与远端同步 `gzipSync` 阻塞；
- **⚠️ 三个连带影响**：①不减少总字节只重新分配（首屏外的量改由 page 请求承担）；②**单独改会让页数变多**（瓶颈是「超预算记录独占一页」，降低预算不缩小记录）→ **须与 A/C 同批落地**；③`historyComplete:false` 更频繁 → 触发 `historyWindowed` 横幅 + 更多 recovery（lane cap=1）；
- **⚠️ 关键**：真正的耗时上界是 `HISTORY_FULL_SCAN_BYTES`=**64 MB**（扫描预算），不是输出预算。只降输出等于允许「读 64 MB 吐 8 MB」，**延迟上界没变** → 建议**配对**降到 24 MB（待裁决）；
- **回归已核对**：测试断言为宽松区间（`>0 && <40`），8 MB 下仍过；无 `.js` 孪生；无硬编码断言；
- **生效方式**：server 侧 TS 由 bun 直跑，**仅需重启 sidecar**，无需 `vite build`。

### 硬约束（方案可行性前提，详见报告第六节）

- **`originalFile` 是 schema 必填 `z.string()`** + `FileEditTool/UI.tsx:90` 无保护 `.split` ⇒ **只能裁成字符串预览，不能删字段**（删则 `safeParse` 失败、结果完全不渲染）；
- **`toolUseResult` 对象不可整体删除**（被 `isHumanTurn` 等当「非人类消息」判别位）；
- **新增键只能进 `toolUseResult` 内部**（顶层键序被 transcript 解析优化依赖）；
- ⚠️ **展示层裁剪切忌置 `bodyTruncated`**——会翻转 `historyComplete=false` → 触发 recovery 循环 + `historyWindowed` 横幅误显（最易踩的坑）；
- recovery / 语义归约路径必须保留原文。

### 实施进度（2026-09-26）

**已落地 A + H**（patch `patches/history-transport-bounds.patch`，3 文件 +108/−17，已往返校验）

| 项 | 落点 | 内容 |
|---|---|---|
| **A** | `boundedSessionHistory.ts` 新增 `boundToolUseResultPreview()` + `sessionService.entryToMessage` 接入 | 传输层对 `toolUseResult` 做有界投影：**只截超长字符串（>16KB）**，键与容器类型全保留；**不置 `bodyTruncated`**（避免翻转 `historyComplete` 触发 recovery 循环）。仅作用于展示/传输路径，**recovery 与语义归约路径仍取原始记录** |
| **H** | `boundedSessionHistory.ts:10/20` | `HISTORY_FULL_BYTES` 32MB→**8MB**；**配对** `HISTORY_FULL_SCAN_BYTES` 64MB→**24MB**（=3× 输出，扫描预算才是延迟上界） |

**实测收益（真实会话 `db39b34d`，1844 条 toolUseResult）**

| 指标 | 前 | 后 |
|---|---|---|
| toolUseResult 合计 | 106.6 MB | **6.6 MB（−93.8%）** |
| 单条最大 | 3.93 MB | **48 KB** |
| `mode=full` 单响应上限 | 33.2 MB（预算 32MB） | **≤8 MB** |

**保留性验证**（关键字段未被破坏）：`filePath` 原样；`structuredPatch` 未被截（hunk 完整，turn diff 依赖）；`originalFile` 仍为**字符串**（满足 `FileEdit` schema 必填 `z.string()` 与 UI 无保护 `.split`）；全部键保留。

**验证**：`boundedSessionHistory` 21/21；会话相关服务端测试 342/342；改动文件 tsc 0 错误；新增 3 个专项用例（截断保键、小结果字节不变、不置 `bodyTruncated`）。

### 追加落地 E + G（patch `file-history-dedup.patch` / `gzip-async-streaming.patch`）

**E｜file-history 重复消除（`fileHistory.ts`）**——`fileHistoryCompleteSnapshot` 原来是**每轮对每个被追踪文件无条件 `copyFile`**，且追踪集只增不减 ⇒ O(文件数 × 轮数) 份拷贝、绝大多数逐字节相同。实测该目录 **1512 MB / 15494 文件，却只有 2057 种内容（87% 是重复）**，估算可回收 **1171 MB（77%）**。

修复：套用 `fileHistoryMakeSnapshot` 既有惯用法 `checkOriginFileChanged()`——内容未变则**复用上一轮的 `-completed-` 备份**，仅在真变化时才建新拷贝；沿用 `-completed-` 命名，**不动 rewind 的 after-boundary 语义**。

**G｜gzip 异步化（`responseCompression.ts`）**——`gzipSync` 在事件循环上完成整个 deflate，而远端历史正是「多页顺序拉取」，每页都会把其他请求连同翻页循环一起卡住。改为 `node:zlib` 的异步 `gzip`（libuv 线程池）。

### ⚠️ C 方案被证伪（重要）

原计划 C「裁掉 `originalFile` 并指向 file-history 备份」**不可行**——实测**反证**：

| 检查（本会话） | 结果 |
|---|---|
| transcript 中 20 个巨型 `originalFile` | 20 个内容互不相同 |
| 能在 file-history 里找到 | **仅 5 个** |
| **备份里没有（裁了即永久丢失）** | **15 个（75%）** |

原因：一轮内多次编辑**不会被逐次备份**，`trackedFileBackups` 只保轮次边界。故 C 不可按原设计实施；如需根治磁盘新增，只能走「有界预览 + 自行落一份内容寻址副本」（磁盘基本持平）或接受**有损裁剪**（需用户明确同意）。**当前以 A（传输层）+ E（存量去重）替代 C**。

### gzip 会话大小门控（G2，用户 2026-09-26 指示，已实施）

**用户指令**：gzip 压缩传输，只有**整个会话大于 10M** 才开启。

> **打包说明**：G（异步化）与 G2（会话门控）同改 `responseCompression.ts`，分两个 patch 会互相包含（后者基于前者生成）→ 顺序应用冲突，故**合并为单个 `gzip-transport.patch`**。

**实现**（patch `gzip-transport.patch`，含 G+G2，共 3 文件 +175/−5）

| 落点 | 内容 |
|---|---|
| `responseCompression.ts` | 新增 `MIN_COMPRESSIBLE_SESSION_BYTES = 10 MB`、`sessionIdFromPath()`；`withGzipIfEligible` 增第 4 参 `resolveSessionSize?` |
| `server/index.ts` | 新增 `resolveSessionSizeBytes()`（`findSessionFile` + `stat`，**10s TTL 缓存**），注入中间件 |

**设计要点**

- **门控放在异步路径、且排在最后**：先过全部便宜检查（GET/200/json/gzip 协商/非 loopback），再查会话大小 → **loopback、小响应、非会话路由都不付查询成本**；
- **`shouldGzipResponse` 签名不变**（既有 3 参测试不受影响）；
- **查不到大小（`null`）→ 回落为压缩**，避免 stat 抖动把大会话误判为不压；
- 每响应 128KB 底线（`MIN_COMPRESS_BYTES`）**保留**，与会话 10MB 底线**同时生效**；
- 10s TTL 缓存让 H5 翻页（数百次请求）只查一次。

**评估备注（与先前分析的关系）**：本项为**用户明确决策**，优先于此前「按响应即可」的建议。实测压缩收益仍成立（裁剪后比率 4.4–6.0x，128 KB 档 2.4 ms 换 ~99 KB），故 10MB 门控属**保守选择**：小会话放弃压缩、换取零 CPU；大会话行为不变。

**实测数据（裁剪后真实会话，18.9 MB JSON）**

| 原始 | gzip 后 | 比率 | 中位耗时 |
|---|---|---|---|
| 32 KB | 9 KB | 3.5x | 0.9 ms |
| 128 KB | 29 KB | 4.4x | 2.4 ms |
| 256 KB | 57 KB | 4.5x | 4.3 ms |
| 1 MB | 217 KB | 4.7x | 16 ms |
| 8 MB | 1.36 MB | 6.0x | 102 ms |

**附带发现（不修，但已用测试钉住）**：Bun 的 `Response.json()` **不设 `content-length`**，故 `responseCompression.ts` 的「按声明长度快速跳过」**从不触发**——小响应会先被 `arrayBuffer()` 缓冲、再由 body 长度判定，因此**小响应也会触发一次会话大小查询**（有 10s 缓存，成本可忽略）。已加用例 `a small response still compresses nothing, though the size is consulted` 固定该顺序，使未来改动成为显式决策。

### B｜首屏翻页上限（已实施）

**问题**：`getFullHistory` 从 `mode=full` 起按 `nextCursor` **无上限**拼接，且**结束时把 `nextCursor` 置 null**。两个后果：①时间线在整个拼接完成前不渲染 → 深会话表现为「打不开」；②`MessageList` 的「加载更早」入口条件是 `historyWindowed && historyPage.nextCursor`，而 `nextCursor` 恒为 null ⇒ **既有分页链路永远不可达**。

**修复**（`desktop/src/api/sessions.ts`，+2 常量）：拼接循环加 `HISTORY_STITCH_MAX_PAGES = 40` 与 `HISTORY_STITCH_DEADLINE_MS = 12_000` 两个上界，越界即 `break`；返回时改为 `nextCursor: cursor`、`hasMore: !exhausted`，`historyComplete` 仅在真正走完（`cursor === null`）时才可能为 true。

**关键性质**：`cursor === null`（走完）时各字段与旧的「无条件 null」行为**完全一致**——**提前返回是唯一新增路径**，故既有测试 23 个一字未改即通过。

**效果**：首屏**不再阻塞**；剩余历史由**既有**「加载更早」按钮接管（每点一次 prepend 一页），无需新建渐进渲染系统。

**未做的另一半（`projectContext: false`）——有意不做**

调研发现 `getSessionHistoryPage` 在 `projectContext !== false` 时会调 `projectHistoryPageEntries` **从文件头重建 ownership 索引**（源码注释明确：「this is what stalls the shared server while a model pages backward」），这很可能是 13.6 MB 会话也超时的元凶；而 `/messages` 端点**从不传** `projectContext:false`（`conversationService.ts:425` 与 `sessionCollaborationHost.ts:80` 都传了）。

但该索引产出的是**父子 tool-activity 归属**，而渲染层**依赖**它把子代理活动并入主时间线——关掉即**丢功能**。故**不擅自实施**，列为待你裁决的候选优化（若要尝试，建议做成「首屏 `projectContext:false` + 后台补索引」两步，而非整体关闭）。

### F｜存量瘦身（已实施，2026-09-27）

**用户指示**：先全量备份，然后直接开始瘦身。

**① 全量备份（前置条件，已核实）**

| 项 | 值 |
|---|---|
| 备份位置 | `/mnt/data1/claude-backup-20260927-023315/` |
| 内容 | `projects/`（3.2 GB，519 个 jsonl，与备份时源目录同数）+ `file-history/` + `tasks/` |
| 抽查比对 | `3e0bcac3` 343 MB、`07e8b34d` 284 MB、`40e72cd0` 179 MB —— 均为**瘦身前**体积 |

**② 瘦身口径：写入侧收口（非改写存量语义）**

`sessionStorage.ts` 新增 `boundOriginalFileForStorage()`，在 `cleanMessagesForLogging()` 落盘路径上对 `toolUseResult.originalFile` 施加 **16KB** 上限，并写 `originalFileTruncated: true` / `originalFileBytes: <原长>` 让记录自证被裁。

- **为什么裁它**：`originalFile` 是编辑前的整文件，**模型看不到**（走 API 的是 `mapToolResultToToolResultBlockParam`），编辑卡片的 diff 实际读 `structuredPatch`。实测该字段占 transcript 的 ~2/3（3.1 GB 中 2.1 GB）。
- **为何只裁这一个字段**：其它 `toolUseResult` 字段会被 recovery / 语义归约路径读回，必须保留原样。
- **与既有传输层一致**：上限取 `TOOL_USE_RESULT_STRING_LIMIT`（16KB，`boundedSessionHistory.ts`）**同一个数**——客户端历来的预览就是这个界，故**源侧裁剪不改变任何人可见的内容**。

**③ 实测收益**

| 指标 | 前 | 后 |
|---|---|---|
| `~/.claude/projects` 总量 | 3.1 GB | **1.2 GB（−61%）** |
| `3e0bcac3` | 359 MB | **61 MB** |
| `07e8b34d` | 297 MB | **7.5 MB** |
| `6877e7d2` | 261 MB | **13 MB** |
| `40e72cd0` | 186 MB | **17 MB** |
| `db39b34d` | 119 MB | **19 MB** |

**④ 验证**：`sessionStorage.originalFileBound.test.ts` 专项用例（小结果不动、超限裁剪且标记正确、非字符串/非对象透传）与 `pipInstall` 合并跑 **15/15 通过**；改动文件 tsc 0 报错。

### 状态

🔍 调研完成 + 方案定稿（报告 v2）；**A+B+H+E+G+G2 已实施**（patch 第 25–28 位），**C 已证伪**，D 需重估，**F 已实施**（patch 第 33 位，2026-09-27，备份已核实）。

**本轮 patch（5 个，改文件互不重叠）**

| patch | 位置 | 内容 | 生效方式 |
|---|---|---|---|
| `history-transport-bounds.patch` | #25 | A 有界投影 + H 预算收紧（8MB/24MB） | 重启 sidecar |
| `file-history-dedup.patch` | #26 | E `-completed-*` 重复消除 | 重启 sidecar |
| `gzip-transport.patch` | #27 | G 异步化 + G2 会话 10MB 门控（同文件故合并） | 重启 sidecar |
| `history-first-paint-bound.patch` | #28 | B 首屏翻页上限 | **前端须 `vite build`** |
| `storage-original-file-bound.patch` | #33 | F 写入侧 `originalFile` 16KB 有界裁剪 | 重启 sidecar（**仅影响新写入**） |

**全量验证（2026-09-26）**：服务端 `bun test src/server/` **3452 pass / 0 fail**（178 文件）；`desktop/src/api/sessions` **24/24**、`chatStore` **354/354**；四 patch 链式应用后与工作树 diff **逐字节一致**；改动文件 tsc **0 新增错误**（`index.ts` TS2502 经暂存法核验为**既有基线**：HEAD 在 281 行、加 36 行后位移至 317）。

**F 的生效边界（重要）**：写入侧裁剪**只约束此后的新写入**；存量瘦身是**已执行的一次性数据操作**（备份即其回滚点），不属于 patch 的可重复效果——重放 patch 不会、也不应再次改写历史文件。

---

## 二十三、子代理内容实时反馈（opencode 式，替代当前间隔刷新）（⬜ 待办，仅登记，2026-09-26）

### 需求背景（用户 2026-09-26 verbatim）

「子会话的子代理think、思考的内容改为实时反馈（类似 opencode 的样式），而不是间隔刷新。此作为新增优化项，仅做记录，暂时不做处理。」

### 现状

- 主会话流式 thinking/正文逐 delta 实时渲染（`content_delta`/`thinking` WS 事件 → chatStore 即时 append）；
- 子代理（Agent 工具派生的 run）内容经 `agent_run_event` 路由到子会话，**展示为间隔刷新**（子会话事件批量落地/整块落盘后统一映射，非逐 delta 跟随）；
- 参照物=opencode：子代理输出与主会话同级逐 token 流式呈现。

### 方案要点（实施时细化）

- 子会话流事件（thinking/content_delta）逐条透传渲染，复用主会话既有 merge 路径（`findStreamMergeTargetIndex`/`joinThinkingContent`）；
- 需核对 `agent_run_event` 批量缓冲（`pendingAgentRunEvents`/`bufferAgentRunEvent`）是否在实时路径上造成合并粒度变粗；
- 子代理卡片（Agent 工具行）内嵌实时预览 vs 子会话页实时，二选一或双通道（实施时定）；
- 与章二十一 badge 机制正交（badge 读 `thinkingDurationMs`，实时反馈只改渲染粒度）。

### 状态

⬜ 待办（2026-09-26 登记，**仅记录暂不推进**）；无 patch。

---

## 二十四、上下文压缩阈值按窗口分档（软触发百分比 + 硬触发绝对下限）（⬜ 待办，仅登记，2026-09-26）

> 用户 2026-09-26 指示：**先做记录**，暂不推进。

### 需求背景（用户 verbatim）

> 将100K及以内上下文，设定剩下13%开始压缩上下文，或剩下小于13K开始强制执行压缩上下文
> 将200K及以内上下文，设定剩下17%开始压缩上下文，或剩下小于32K开始强制执行压缩上下文
> 将300K及以内上下文，设定剩下21%开始压缩上下文，或剩下小于36K开始强制执行压缩上下文
> 将500K及以上上下文，设定剩下15%开始压缩上下文，或剩下小于65K开始强制执行压缩上下文

### 0.6.6 现状核对

实现位置：`src/services/compact/autoCompact.ts`

| 锚点 | 行 | 现状 |
|---|---|---|
| `getAutoCompactThreshold(model)` | :97 | = `getEffectiveContextWindowSize(model)` − `autoCompactBuffer` |
| `AUTOCOMPACT_BUFFER_TOKENS` | :87 | **= 13_000，固定值，与窗口大小无关**（仅 `cap` 到 `window/3`，:103-106） |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | :110-119 | 已有百分比旁路，但取 `min(window×pct, 固定阈值)`，属**测试用**覆盖，非分档 |
| `getEffectiveContextWindowSize(model)` | :44 | = 标称窗口 − 摘要预留（预留 = `min(模型maxOutput, 20_000, window×0.25)`，:36-41、:67-73） |
| `WARNING/ERROR_THRESHOLD_BUFFER_TOKENS` | :88-89 | 均 = 20_000 |
| `MANUAL_COMPACT_BUFFER_TOKENS` | :90 | = 3_000 |
| `calculateTokenWarningState()` | :124 | 出口：`percentLeft` / `isAboveWarningThreshold` / `isAboveErrorThreshold` / `isAboveAutoCompactThreshold` / `isAtBlockingLimit` |

消费点：`src/query.ts:649`（`isAtBlockingLimit` → 强制路径）、`src/components/TokenWarning.tsx`（UI 百分比与文案）、`src/components/PromptInput/Notifications.tsx:93`。

**现状问题（与本优化诉求一致）**：固定 13K 缓冲**不随窗口伸缩**——512K 窗口下仅剩 ~2.5% 才触发（太晚），32K 小窗口下 13K=41%（靠 `cap` 到 `window/3` 兜底，语义含糊）。

### 规格（定稿，2026-09-26 二次修订）

| 上下文窗口 | 软触发（剩余百分比） | 硬触发（剩余绝对量） |
|---|---|---|
| ≤100K | 13% | <13K |
| ≤200K | 17% | <32K |
| ≤300K | 21% | <36K |
| ≤500K | **17%**（用户 22:5x 定稿，取代早前插值方案） | **<53K** |
| ≥500K | 15% | <65K |

**三个实施口径（已定，代码落地为准）**

1. **分档键 = 声明窗口**（`getResolvedContextWindow`，即 provider 预设/内置表/`[1m]`/`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 的结果，**不扣**摘要预留）——因为「100K/200K/…」说的是窗口本身；
2. **阈值算在有效窗口**（`getEffectiveContextWindowSize`，已扣摘要预留）——因为比较对象是真实 token 用量；
3. **硬触发算在声明窗口**（`declared − floor`），与分档同基准；并以 `max(..., 软阈值)` 钳制，保证**永不早于软触发**。

**小窗口安全钳制（新增，必要）**：软阈值取 `min(档位阈值, window − min(13K, window/3))`。12K 有效窗口下「剩 13%」只有 1.5K token，压缩来不及会先 `prompt_too_long`；保留原 `window/3` 兜底后**小窗口阈值与旧实现逐字节一致**（8K/16K/16.5K/35K/47K），零回归。

**换算表（有效窗口实测值）**

| 模型 | 声明 | 有效 | 档位 | 软阈值（已用≥） | 硬阈值（已用≥） |
|---|---|---|---|---|---|
| deepseek-v4-pro / GLM-5.2 | 1M | 980K | ≥500K 15% | 833,000 | 935,000 |
| k3 / kimi-k2.6 | 262,144 | 242,144 | ≤300K 21% | 191,293 | 226,144 |
| MiniMax-M2.7 | 204,800 | 184,800 | ≤300K 21% | 145,992 | 168,800 |
| glm-5.1 | 200,000 | 180,000 | ≤200K 17% | 149,400 | 168,000 |
| glm-4.5-air | 128,000 | 108,000 | ≤200K 17% | 89,640 | 96,000 |
| gpt-5.6-terra | 353,400 | 333,400 | ≤500K 17% | 276,722 | 300,400 |
| 368,640（老外的API 预设） | 368,640 | 348,640 | ≤500K 17% | 289,371 | 315,640 |
| custom-16k/32k/64k/80k | — | — | ≤100K 13% | 8,000 / 16,000 / 35,000 / 47,000（同旧值） | 同软 |

> 注：100K 档软硬重合（13%×100K=13K）；`≤500K` 档内侧 300K–312K 区间 `floor(53K) > window×17%`，被 `max(..., 软)` 钳制成「硬=软」，无倒挂。

### 实施记录（2026-09-26 已完成）

**改动**：`src/services/compact/autoCompact.ts`（+125 行）、`src/services/compact/autoCompact.test.ts`。

| 落点 | 内容 |
|---|---|
| `getResolvedContextWindow(model)` | **新增**：拆出「扣预留前」的声明窗口（原 `getEffectiveContextWindowSize` 的窗口解析部分），供分档使用 |
| `AUTOCOMPACT_TIERS` | **新增**：单一常量表（5 档，含 `≤500K 17%/53K`） |
| `getAutoCompactTier(window)` | **新增**：落档查表 |
| `getAutoCompactThreshold(model)` | **改写**：档位百分比阈值 + legacy `min(13K, window/3)` 安全钳制 + 保留 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` |
| `getForcedCompactThreshold(model)` | **新增**：硬触发（声明窗口 − floor），以 `max(…, 软)` 钳制防倒挂 |
| `calculateTokenWarningState()` | **扩展**：新增 `isAtForcedCompactLimit` 出口；`percentLeft` **分母由 threshold 改为有效窗口**（原实现到压缩点显示 0%，与「剩 13%」语义相悖） |
| `shouldAutoCompact()` | 触发条件改为 `软 ∥ 硬`（硬为兜底：软按构造总是先到）；调试日志加 `forcedThreshold` |

**验证**

- `bun test src/services/compact/` → **17/17 通过**（含 12 个 autoCompact 用例）；
- `analyzeContext` + `inProcessRunner` → 25/25 通过；
- 类型检查（`tsc --noEmit`，仓库根 tsconfig 为既有噪声基线）→ **本次改动文件 0 错误**；
- 既有 3 个「硬编码旧固定 13K 预期」的用例已按新分档更新（`k3[1m]`/`deepseek-v4-pro`/`gpt-5.6-terra` 边界），并**新增分档专项用例**（含 300K–500K 档取值 + 硬≥软断言）；
- 小窗口 5 个用例（16K/32K/33K/64K/80K）**未改动即通过** → 证明安全钳制保住了原行为。

### 状态

✅ 已实施（2026-09-26）；patch `patches/autocompact-window-tiers.patch`（第 24 位入库，已往返校验）。
**待重启 sidecar 生效**（server 侧 TS 由 bun 直跑；前端 bundle 不含该常量，无需 vite build）。

---

## 二十五、H5 打不开子代理运行记录（移动端 tab 白名单遗漏 run 记录页）（✅ 2026-09-27）

### 问题（用户 verbatim）

> H5访问的打不开子代理运行记录。无法查看子代理在运行中的情况。

### 根因

`desktop/src/components/layout/AppShell.tsx` 有一个**仅移动端**（`isMobileShell`）的守卫 effect：activeTab 若不属于 `session`/`settings`/`market`/`scheduled` 就**强制切回聊天 tab**（没有聊天 tab 时把 `activeTabId` 置 null）。

`subagent` / `team-member` **从未登记进该白名单** → H5 上点开子代理运行记录后立刻被弹回主会话，表现就是「打不开」；桌面端该 effect 不执行（`isMobileShell === false`），所以完全复现不出来。

该白名单是**随移动端逐页支持而扩展**的（`market` 与 `scheduled` 都是各自章节补进去的），run 记录页漏了。

### 实现（2 文件）

- **`AppShell.tsx`**：守卫白名单补 `subagent` / `team-member`，并加注释说明「run 记录页本就是移动端可达目的地（`ContentRouter` 渲染它们，两页都有移动端布局）」。
- **`AppShell.test.tsx`**：新增 2 用例——
  1. 移动端 `activeTab` = subagent 时**不得**调用 `setActiveTab`（修复前会被弹回聊天 tab）；
  2. **反向守卫**：`activeTab` = terminal（手机无法渲染的 tab）仍必须回落到聊天 tab，防止白名单被过度放宽。

### 踩坑记录（本项）

1. **「只有 H5 坏、桌面正常」优先找 `isMobileShell` 分支**：桌面不走该 effect，因此桌面复现不出来，最容易误判成服务端/接口问题（本次我先查了 H5 访问门禁、`remoteBrowserPolicy`、`/api/.../subagents/by-tool` 路由与静态 dist 解析，均为正常，最后才回到 AppShell）。
2. **白名单是一张隐性登记表**：移动端每新增一个「可打开页面」，都必须同时登记进这个守卫，否则页面**点开即被弹回**且**没有任何报错**，只能表现为「打不开」。此后新增移动端页面应把「守卫白名单」列为固定核对项。（本次一并核对了 `connectors`：它会被迁移成 `market`，因此无此问题。）
3. **放宽白名单要同时钉住边界**：白名单只会被放宽、很难被收窄，故补一条反向用例（terminal 仍回落）把「什么才算移动端可达」固定下来。

### 验证

- `AppShell.test.tsx` **24/24**（新增 2 条）；`tsc --noEmit` 0 错。
- `npm run build:renderer`（vite build，2.67s）后 grep 产物 bundle，确认最小化守卫已含 `"subagent"===` 与 `"team-member"===` 两个分支 → 前端确实带上了修复。
- H5 实测路径：7788 dev sidecar（`CLAUDE_H5_DIST_DIR=<仓库>/desktop/dist`）重启后服务的就是重建后的 dist。

### Patch

`patches/h5-mobile-run-records.patch`（链位 **36**，2 文件 75 行）。全链 **35 → 36** 个 patch，在干净 `068b3ebd` 上按表序 `git apply --allow-empty` **失败 0**；`AppShell.tsx` / `AppShell.test.tsx` 终态与工作树**逐字节一致**。

---

## 附录：交接备注（2026-09-27 更新）

- #83 测试失败：前端全量 vitest 12456 pass/2 fail（2=MessageList 同一用例负载 flaky，已加 timeout:5000 缓解+孪生已同步）；server 侧 `bun run check:server` 本地坑=shell snapshot 把 `process.cwd()` 重置回 gov-managerment-plan（bun -e 实证），绕过法=/tmp/srv-exit.sh 逐文件 exit-code 判定（权威=CI 干净 checkout 无 .js 孪生双重收集）。
- #84 deb：desktop/scripts/build-linux.sh LINUX_TARGETS=deb SKIP_INSTALL=1（先 tsc 孪生同步，TS5096 不阻断）。
- **编译耗时实况（2026-09-27 实测）**：`bun run build` = preview-agent 0s + `tsc -b` **45s** + `vite build` **3s** ≈ **48s**；`tsc -b` 冷/热同价（删 `tsconfig.tsbuildinfo` 不额外花钱，实测冷 46s）；完整 deb 打包（热缓存）约 **2–3 分钟**。故「编译一次 >20 分钟拿不到结果」的成因是**调用姿势**而非编译本身：`timeout 1200 ... | tail -20` 的兜底超时 + 管道缓冲使输出到进程结束才可见，再叠加多个重活（build/vitest×2）抢 CPU。**规矩**：长命令走后台 + 日志文件轮询，禁止 `| tail -N` 阻塞；同一时刻只跑一个重活；纯前端迭代用新增的 `bun run build:renderer`（**实测 3.01s**，对比 `build` 的 48s）。
- **同一工作树内的「目录级测试失败」多为并发污染**：`bun test src/utils/computerUse/` 整目录跑出 24 fail，而**逐个文件隔离跑全部 0 fail**（27/27 文件）。判定真回归前先隔离复跑。

### ⚠️ 坑：根 `tsc --noEmit` 的 3500+ 报错**不是缺陷**

仓库**根目录没有声明 typescript/@types/node，也没有 typecheck 脚本**（`desktop/` 才有）。因此拿根 `tsconfig.json` 跑全量 `tsc --noEmit` 会得到约 **3526 条错误 / 1002 文件**，经逐一归因**全部是机制产物**，勿据此"修 bug"：

| 成因 | 条数 | 说明 |
|---|---|---|
| `@/` 别名 | 793 | 该别名只在 `desktop/tsconfig.json` 的 `paths`（`@/* → src/*`）里，根 tsconfig 未定义；全在 `desktop/` |
| MACRO 注入 | 144 | `MACRO` 由 bun 构建期注入，tsc 单跑必然 `Cannot find name` |
| **桩模块** | ~640 | `src/` 下 **138 个自动生成桩**（文件头注明 `@generated stub from scan-missing-imports`，对应 ant-internal 的 `feature()` gated 模块，外部构建 DCE 后不执行）；导出被 Proxy 兜底 → 真模块的命名导出在桩里不存在 → TS2614，并**级联**出 `type 'never'` 等大量 TS2339 |
| 外部构建死分支 | ~100 | `feature()` gated 分支在外部构建下为死代码，`'"external"' 与 '"ant"' 无 overlap`（TS2367） |
| 未开 strictNullChecks | ~200+ | 根 tsconfig 未设 `strict`/`strictNullChecks`；**`strictNullChecks: false` 会破坏判别联合的真值收窄**（最小复现：`{ok:true}|{ok:false}` 上 `if(!r.ok) r.error` 报 TS2339，开 true 即通过）→ workflows/worktree 那批"属性不存在"全是此因 |

**权威检查是各子项目的配置**：前端 `cd desktop && node ./node_modules/typescript/bin/tsc --noEmit`（`include: src`），它才是 CI/lint 用的（`desktop/lint` = eslint + 该 tsc）。

**由此捞出的 2 处真缺陷**（已修，patch 第 29 位）：
1. `src/server/index.ts` **TS2502**——`const serverFetch = (req, server: typeof server)`：参数名 `server` 遮蔽外层同名变量，类型注解里的 `typeof server` 解析成**它自己** → 循环自引用（最小复现：只改参数名即消失）。后果**不止一行报错**：该参数类型退化为循环引用，函数体内 4 处 `server.requestIP` / `server.upgrade` **全部丢失类型检查**。修法=提取具名 `type ServerHandle`。
2. `src/vendor/computer-use-mcp/toolCalls.test.ts` → **4 条 TS2300** 重复导入（`bindSessionContext` ×2、`ComputerUseSessionContext` ×2）。
