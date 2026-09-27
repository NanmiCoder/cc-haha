# Computer Use 重新设计 — 交接 context(新 worktree 从零开始用)

> 配套文档(同目录,一起带走):
> - `computer-use-codex-redesign.md` —— 架构对比 + 重设计规格 + 对抗式审计(根因为什么慢/不顺/不准)
> - `computer-use-codex-impl-blueprint.md` —— **权威实现规格**(skyshot 精确文本格式 / 遍历 / 注入梯度 / 工具面 / staleness / 截图 / per-app)

---

## 1. 这是什么 / 目标

给 Electron 桌面应用 **"cc-haha"**(Claude Code 的 fork,桌面端是 **Electron 0.4.0**,不是 Tauri)做一个原生 macOS **Computer Use**(让模型操控本机 App)。

**核心目标 = 完美复刻 Codex 的 Computer Use:① 好用 ② 复刻全部功能 ③ 快。** 不写兼容/补丁代码,接口层到 helper 层都可重设计。

现状:旧实现是 **"整屏截图 → 模型肉眼找像素 → 合成事件点坐标"** 的盲操,慢/注入不顺/截图不准。要换成 Codex 的 **"读 AX 树 → 按元素 index 语义点"**。

---

## 2. 核心架构判断(为什么 Codex 好)

| | Codex(好) | 旧实现(差) |
|---|---|---|
| 感知 | **`get_app_state`**:关键窗口的 **AX 树 + 窗口截图**,一回合一次,发 diff | 整屏截图,每动作后重截 |
| 定位 | 按 **AX 元素 index** 语义点(或像素兜底) | 只有整屏像素坐标 |
| 注入 | **纯 AX**(`AXUIElementPerformAction`),不抢鼠标、不靠焦点 | `CGEvent.postToPid` 像素,对 Electron 不稳 |
| 传输 | XPC | socket + NDJSON + base64 图 |

**一句话根因:Codex 是 AX-tree 语义驱动,旧实现是截图-像素盲操。** 改这一条,慢/不顺/不准同时解决。
**命门(唯一核心不确定点):AX 对 Electron/Chromium 灵不灵** —— 要对目标 App 开 `AXEnhancedUserInterface`/`AXManualAccessibility` 强制暴露 AX 树。Codex 这么做(已证),我们也这么做,但**没真机验过**——新 worktree 第一件事就是真机验这个。

---

## 3. 目标交互(要做成什么样)

**模型的操控循环(=Codex 的循环):**
```
get_app_state(app)  ── 返回 {AX 树文本(带 index 的可点元素) + 该窗口截图} ──▶ 模型
       ▲                                                                        │
       │  每个动作后自动重拍 get_app_state(模型不用手动重查)                      ▼
       └────────────────  click(index)/set_value/type_text/scroll/...  ◀────────┘
```
- **一回合一次 get_app_state**,然后多次语义动作;动作返回 = 自动重拍新状态。
- 9 个工具(逐字):`list_apps, get_app_state, click, perform_secondary_action, set_value, scroll, drag, press_key, type_text`。

**视觉交互(用户看到的,要复刻 Codex 的"看得见但不抢"):**
1. **虚拟光标**:屏上一个动画光标从 A 平滑滑到 B(ease/弹簧),**不是**真鼠标(真鼠标全程不动)。样式要好看(Codex 是个精致的合成光标)。**不能阻塞动作**(旧实现把 glide 的 await 卡进点击路径,每点≤0.5s 白等)。
2. **被控窗口着色边框**:正在操作的 App 窗口外缘一圈柔和发光边框,**跟随窗口移动、随窗口隐藏而消失**(AX 观察者驱动)。亮度要柔和(别刺眼闪烁)。
3. **授权卡片**:缺权限时弹一张原生卡片(辅助功能 + 屏幕录制),一键授权 + 拖进系统设置 + 实时状态翻绿(照搬 Codex 的 onboarding 卡片)。
4. **(Codex 有,可选)** per-app 授权弹窗(MCP elicitation)、确认策略(危险动作阻塞确认)、菜单栏"停止/正在操控"。

> 没有现成交互截图;**最好的"交互图"就是 Codex 本体**——直接开 Codex 跑一次 Computer Use,录屏/截图它的虚拟光标 + 着色边框 + 授权卡片 + get_app_state 返回,照着做。

---

## 4. Codex 实现参考路径(本机就能扒)

**插件目录**:`/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/`
- `skills/computer-use/SKILL.md` —— 工具契约 + **完整确认策略**(Hand-Off/Always-Confirm/Pre-Approval/No-Confirm 四档)。
- `.mcp.json` —— MCP server = `SkyComputerUseClient mcp`(stdio)→ 经 XPC 连后台 `SkyComputerUseService`。
- `Codex Computer Use.app/Contents/MacOS/SkyComputerUseService` —— **特权服务**(AX + 截图 + 注入)。`nm -u` / `strings` 它扒符号:get_app_state 语义、纯 AX 注入(`_AXUIElementPerformAction/_AXUIElementSetAttributeValue`,零 CGEventPost)、加速窗口截图(`Capture Accelerated Window Screenshot`/`additionalScreenshotWindowIDs`)、AX 树构建、TurnEnded(`CodexTurnEndedNotification`)、elicitation。
- `Codex Computer Use.app/Contents/SharedSupport/`:`SkyComputerUseClient.app`(MCP 前端,XPC=`ComputerUseIPCXPCTransport`)、`CUALockScreenGuardian.app`(锁屏/物理输入接管/SSRF)、`Codex Computer Use Installer.app`(AuthorizationPlugin)。
- `.../Resources/Package_ComputerUseClient.bundle/Contents/Resources/AppInstructions/*.md` —— **per-app 指令(OpenAI 版权,只看格式别抄)**。
- `.../Package_ComputerUse.bundle/Contents/Resources/Skysight{Summarizer,MemoryInstructions}.md` —— Skysight 记忆子系统 prompt。

**Codex App 本体源码**:`/Applications/Codex.app/Contents/Resources/app.asar`(143MB,`bunx asar list/extract`)—— 看 client 怎么驱动服务、UX。

**签名事实**:Codex 全链 Developer ID + 公证(TeamID `2DC432GLL2`)。我们 helper 是 Apple Development(未公证)——**本地用够,公证只在对外分发/做独立 XPC 服务时需要(需 Apple 付费账号,用户还没有)**。

---

## 5. 能真参考的开源项目(都已逆向 Codex,先 re-clone 到 /tmp)

| 仓库 | 语言 | License | 用途 |
|---|---|---|---|
| **`github.com/iFurySt/open-codex-computer-use`** | Swift | **无 license = 保留所有权利,只读参考别抄码** | `docs/references/codex-computer-use-reverse-engineering/`(逆向架构 + **`tool-call-samples-2026-04-17.md` = Codex 真实 get_app_state 输出,渲染器必须对照它逐字断言**);`AccessibilitySnapshot.swift`=**格式权威**;`ComputerUseService.swift`=注入梯度;`KeyMapping.swift`/`ToolDefinitions.swift` |
| **`github.com/OpenCodexLabs/open-codex-computer-use`** | Swift | **MIT(可借鉴,注明)** | 同款 MCP-NDJSON 传输;`AppState.swift`(遍历/staleness/(windowIndex,path) 定位)、`UIElementService.swift`(注入)、`WindowCapture.swift`(窗口锁定截图 + SCK 卡死→screencapture 兜底)、`CodexCompat.swift`+`main.swift:768-810`(get_app_state envelope 框装)+`:1517-1580`(**变更后自动重拍**)、`AppGuidance.swift`(frameReliability) |
| **`github.com/vtomnet/codex-cua-tea`** | docs | OpenAI 版权内容 | `SkyComputerUseService.md`(工具面/skyshot 语义)、`AppInstructions/*.md`(per-app 指令逐字,**只看格式**) |

> **IP 纪律(产品要 ship):** 自己写代码符合规格,**不要 verbatim 抄任何仓库的 Swift**;skyshot 文本【格式】是互操作协议(对齐 OK),渲染器【代码】自己写。AppInstructions 的内容是 OpenAI 版权,只学结构。

---

## 6. 关键踩坑 / 教训(别重新踩)

- **TCC 双主体规则(实证抓 tccd 坐实)**:**屏幕录制**主体 = 路径上**最外层 .app**(helper 嵌在宿主 app.asar.unpacked 内 → 主体=宿主 → 只能授权宿主,或把 helper 拷到独立路径让主体=自己);**辅助功能/注入**主体 = **进程自身代码身份 = helper**(嵌套也不变)。两条独立。
- **独立安装解法(方案A,无需公证)**:首次运行把 helper.app 从 app.asar.unpacked **拷到 `~/.claude/cu-helper/`**(自写文件无 quarantine → 不被 App Translocation),从独立路径 `open -n` 启动 → 录屏主体=helper 自己。TCC 按**证书型 DR** 匹配(非路径),授权一次跨重打包不丢。(已实现:`src/utils/computerUse/cuHelperInstall.ts`)
- **hardened runtime 的 release/.app 不能裸 shell exec**(SIGKILL);`open -n` 受 **LaunchServices bundle-id 去重**;本地测 daemon 只能用 **debug build 裸二进制**(无 hardened),且要给它授权才有 AX。
- **@MainActor 闭包跑后台 DispatchQueue 会 SIGTRAP 崩 daemon**(`setEventHandler` 不是 @Sendable 会继承 @MainActor)—— AX 全程主线程,后台 timer 的 handler 必须显式 `@Sendable`。
- **disclaim**(`responsibility_spawnattrs_setdisclaim`):裸 exec 的 CLI/卡片用它成自身责任进程;daemon 经 `open -n` 不用。
- **不抢鼠标**:合成事件只用 `CGEvent.postToPid(pid)` + `.combinedSessionState`,**绝不**用 `.cghidEventTap`/`.hidSystemState`。
- **skyshot 格式细节**(blueprint §1 有全量):`App=bundleId (pid N)` / `Window: "t", App: App.` / `\t` 缩进 / 人性化 `kAXRoleDescription`(不是 AXRole)/ `(traits)` / 裸 title / Description:/Help:/ID:(滤 `_NS:`)/Value:/Secondary Actions:(pretty+denylist) / **不打 frame** / 末尾 `The focused UI element is …` / 160 截断。
- **Electron 关键**:不做"泛容器消除/扁平化 + 并 AXRows/AXContents"的话,Electron 的 AXWebArea 是几千空 wrapper,撑爆上限够不到有用控件 ——"Electron 读不到树"多半是这个,不是 AX 本身。

---

## 7. 这个 worktree 已实现到哪(可复用/可参考,也可推倒)

worktree `quizzical-lehmann-5ab084` 里已写好一版**编译绿 + 格式对样本验过**的实现(运行期未验,缺 AX 授权):
- `native/cu-helper/Sources/cu-helper/`:`AXTree.swift`(get_app_state 格式+遍历+定位+per-pid 会话)、`AXAction.swift`(6 级注入梯度)、`KeyMapping.swift`、`Capture.swift`(窗口锁定+卡死兜底)、`AppGuidance.swift`、`CommandRouter.swift`(9 命令+staleness)。
- `src/vendor/computer-use-mcp/`:9 工具面 + get_app_state envelope + 自动重拍(TS 138 测试绿)。
- `src/utils/computerUse/cuHelperInstall.ts`:独立安装(方案A)。
- 崩溃修复:`WindowFrameTracker.startPolling` 的 @Sendable handler。
- **未做(外围)**:TurnEnded 跨层协议、MCP elicitation 授权、Skysight 记忆、Record&Replay、锁屏守护、XPC 传输(阶段2 需公证)。

新 worktree 可以:(a) 把这 6 个 Swift + TS 工具面 + cuHelperInstall.ts 直接拿过去当起点;或 (b) 只把本文 + blueprint 当规格从零写。**无论哪种,第一步都是真机验命门(AX 对 Electron)。**
