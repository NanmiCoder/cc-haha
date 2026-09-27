# Computer Use 原生重构 —— 真机验证清单

> 这份清单只列**自动化测不到、必须真人在真机上做**的项。
> 已自动化的部分（3000+ 单测、185 个 Swift 测试、平台路由、失败关闭、签名契约）见提交说明，不重复。
>
> 前置：`bash native/cu-helper/build.sh` 能出 `.app`；或走 `cd desktop && bun run build:sidecars`。

---

## 0. 准备（每次重装都要重做一遍）

1. 构建 helper：
   ```bash
   bash native/cu-helper/build.sh
   ```
   记下最后一行 `built: <路径>`。

2. **必须用安装版 `.app` 测授权**。re-sign 过的 debug 二进制是新的 cdhash，TCC 不认它继承任何授权 —— "我明明授权了却还是没权限" 十有八九是这个。

3. daemon 必须用 LaunchServices 起，不要裸 exec（hardened runtime 的 release `.app` 裸 exec 会被 SIGKILL）：
   ```bash
   open -n "<built 路径>"
   ```

4. 确认签名身份没有轮换（轮换会让老用户重新授权一遍）：
   ```bash
   codesign -dv --verbose=4 "<built 路径>" 2>&1 | grep -E "Identifier|Authority"
   cat native/cu-helper/.build/.cu-helper.signid
   ```
   `Identifier` 必须是 `dev.cchaha.cu-helper`。

5. **三者同证书 —— 打包版最容易踩的坑，先查这个再查别的。**

   helper 的客户端核验（`ClientAttestation.swift`）要求调用链能被密码学地认定为本应用：**host、sidecar、helper 必须签在同一张证书上**（同 team、同 leaf），且 sidecar 的 identifier 必须精确等于 `com.claude-code-haha.desktop.sidecar`。任何一环对不上，helper 对**所有**命令返回 `unauthorized_client`，表现是设置页权限一直"检测中…"、授权卡片点了没反应。

   ```bash
   APP="desktop/build-artifacts/macos-arm64/Claude Code Haha.app"
   B="$APP/Contents/Resources/app.asar.unpacked/src-tauri/binaries"
   for P in "$APP" "$B/claude-sidecar-aarch64-apple-darwin" "$B/cc-haha-computer-use.app"; do
     codesign -dv "$P" 2>&1 | grep -E "^(Identifier|TeamIdentifier)="
   done
   ```

   期望：三个 `TeamIdentifier` 完全相同，且 identifier 分别是
   `com.claude-code-haha.desktop` / `com.claude-code-haha.desktop.sidecar` / `dev.cchaha.cu-helper`。

   ad-hoc 构建（`SIGN_BUILD=0`，或机器上没有签名证书）**没有证书可言，Computer Use 在其上必然不可用** —— 这不是 bug，是 attestation 的固有前提。要测 Computer Use 就必须用签名构建（默认即是）。

---

## 1. TCC 授权（双主体，两条独立）

> **只有两项：辅助功能 + 屏幕录制。「输入监控」永远不该出现在任何提示里。**
> 历史事故：物理输入监控最初用 listen-only event tap 实现，它需要第三个 TCC 权限（输入监控），
> 而授权卡片从未请求过它 → 新装机上 `ForegroundLease.acquire` 对每个动作抛
> `focus_isolation_unavailable`，整个 Computer Use 不可用，且虚拟光标永不出现（光标动画在
> lease 之后才跑）。现已改为读 HID 系统计数器
> （`CGEventSource.counterForEventType(.hidSystemState, …)`）：零权限、不可失效、
> `postToPid` 注入实测不污染计数器。若真机上动作再次全部报
> `focus_isolation_unavailable`，说明有人把 tap 加了回来——按本节头两行回退。

| # | 步骤 | 期望 |
|---|---|---|
| 1.1 | 首次运行 helper，弹出原生授权卡片 | 卡片出现，**不需要用户敲任何 shell 命令** |
| 1.2 | 点卡片上的「打开辅助功能」 | 直接跳到 System Settings ▸ 隐私与安全性 ▸ 辅助功能 |
| 1.3 | 把 helper 从卡片**拖进**辅助功能列表 | 拖拽落点有效，条目出现并可勾选 |
| 1.4 | 勾选后回到卡片 | 卡片上的状态**实时翻绿**（不需要重启 app） |
| 1.5 | 同样流程走一遍屏幕录制 | 同上 |
| 1.6 | 重新构建 helper 后再看权限 | 两项授权**依然在**（稳定签名身份跨 rebuild 存活）。若掉了，看 §0.4 |

> ⚠️ 屏幕录制的主体是**路径上最外层的 .app**，辅助功能的主体是**进程自身**。会出现"辅助功能授给了 helper、屏幕录制记在宿主名下"的错位——**排障时分开看，别当成一个开关**。

---

## 2. 命门复验（改任何感知层代码前都要重跑）

| # | 靶子 | 步骤 | 期望 |
|---|---|---|---|
| 2.1 | VS Code | **后台**（不置前）读一次 AX 树 | 能读到**完整树**（几百个元素），不是十几个壳元素。<br>后台 `enableEnhancedAX` 应当已生效 |
| 2.2 | VS Code | 置前再读一次 | 元素数量与 2.1 同量级 |
| 2.3 | 网易云音乐（CEF116） | 读网页区 AX 树 | 恒为 0 —— **这是预期**。用它验证**坐标兜底路径**可用：按坐标点击能命中 |
| 2.4 | 任意 App | 观察操作全程 | 真鼠标**全程不动**，虚拟光标平滑滑到目标 |

> ❗ 若发现任何"找不到目标就兜底到 frontmost"的行为，那是 bug —— 它会变成操作宿主自己。

---

## 2.5 CEF/Electron 注入契约（改注入层前必读）

网易云音乐、VS Code、Slack、Discord 这类 Chromium/CEF 应用**按事件声明的窗口做路由**。裸 `CGEvent` 的 `windowNumber` 是 0，这类应用会把它**静默丢弃**——动作返回成功、界面毫无变化。这是本项目栽过最久的一个坑（三轮误判：先怀疑权限、再怀疑坐标、再怀疑 AX 树）。

**点击必须带窗口身份**（`WindowTargetedEvent.swift`）：
1. `NSEvent.mouseEvent(...windowNumber: 目标窗口ID...)` 再取 `.cgEvent` —— CGEvent 没有公开 API 设窗口号，这是唯一途径
2. field 91/92 = 窗口 ID
3. `CGEventSetWindowLocation(cg, 窗口内坐标)` —— 私有 SPI，dlsym；坐标 = 全局点 − 窗口原点，**左上原点不翻转**

**目标在后台时还要切前台并等沉降**（`focusSettleMs = 800`）。`SLPSSetFrontProcessWithOptions` 是**真的前台切换**（不是只给 key focus），切换后**首击会被当成激活点击吞掉**——等 250ms 全失败、等 800ms 全成功。

**键盘不需要这一套**：裸 `postToPid` 即可，完全后台可用、不动指针、不切前台。

| # | 步骤 | 期望 |
|---|---|---|
| 2.5.1 | 目标 App **在前台**，点击一个文本框并输入 | 光标出现、字进去了 |
| 2.5.2 | 目标 App **切到后台**（前台放别的 App），重复上一步 | 同样成功；目标会被带到前台，这是预期 |
| 2.5.3 | 目标**完全后台**时只发键盘（不点击） | 字进去了，**目标不被带到前台、指针不动** |
| 2.5.4 | 全程观察真实鼠标指针 | **从不移动** |

任何一项失败，先查事件有没有窗口身份，别去查权限/坐标/AX 树。

**判定纪律**：只认截图前后对比，不认 API 返回值——"返回成功但什么都没发生"正是这个 bug 的形状。多人/多 agent 同时在一个 App 上做注入实验会互相污染出假阳性，用唯一标记串隔离。

---

## 3. 跨 App 语义操控闭环

| # | 步骤 | 期望 |
|---|---|---|
| 3.1 | `get_app_state` 一个 App | 返回**带 element handle 的 AX 树** + **该窗口截图**（不是整屏） |
| 3.2 | 树里的 handle 形如 `g17:4` | 不是裸数字。裸数字应当被拒绝 |
| 3.3 | VS Code 按 handle 点一个面板开关 | `Value` 0→1；再点回来复原 |
| 3.4 | TextEdit 里 `set_value` 写入文本 | 文本落入字段，返回 before/after |
| 3.5 | TextEdit 里 `select_text` 选一段 | 用独立 AppleScript 读 `AXSelectedText` 校验**逐字一致**：<br>`osascript -e 'tell app "System Events" to tell process "TextEdit" to get value of attribute "AXSelectedText" of ...'` |
| 3.6 | `select_text` 用 `selection_type=cursor_after` | 光标折叠成 length 0 |
| 3.7 | 变更动作的返回体 | 是固定回执 `Action completed. Call \`get_app_state\`…`，**不带截图**（零隐式快照） |
| 3.8 | 换一个进程再用旧 handle | 报 not found —— 这是**预期**，不是 bug |

---

## 4. 视觉层

| # | 步骤 | 期望 |
|---|---|---|
| 4.1 | 操控某个 App 时看它的窗口 | 窗口外缘一圈**柔和光晕**，亮度不刺眼 |
| 4.2 | 拖动被控窗口 | 光晕**跟随窗口移动** |
| 4.3 | 隐藏/最小化被控窗口 | 光晕**随之消失** |
| 4.4 | 截图里检查 overlay | 虚拟光标和光晕**不出现在截图里**，也**不吃鼠标事件** |
| 4.5 | **多屏后台操作**：目标 App 单独放一块屏，自己在另一块屏上工作（前台是别的 App），让 agent 操作目标 | 虚拟光标与光晕**照常出现在目标那块屏上**——可见性判据是「目标窗口在动作点是否露出」，不是「目标是否前台」 |
| 4.6 | 把目标窗口用其他窗口**完全盖住**，再让 agent 操作 | 光标/光晕**不出现**（盖在别人窗口上会误导指向）；动作本身照常执行 |

---

## 5. 安全边界（真机确认，测试已覆盖逻辑）

| # | 步骤 | 期望 |
|---|---|---|
| 5.1 | 让 agent 操控 **cc-haha 自己** | 拒绝：`Computer Use is not allowed to use the app '…' for safety reasons.` |
| 5.2 | 操控 Terminal / iTerm / Chrome | 同样拒绝 |
| 5.3 | 未开 systemKeyCombos 时按 `cmd+q` | 拒绝，提示 `Enable system key combinations in Computer Use settings, then retry.` |
| 5.4 | 开了之后再按 | 放行 |
| 5.5 | 人手动碰鼠标/键盘 | helper 让位，不与真人抢 |

---

## 6. 自动化 smoke（可选，但建议跑一次）

```bash
bun run check:computer-use-live-smoke
```

靶子是 TextEdit，走完整 daemon NDJSON 链路，断言：
- AX 无变化时返回 `There has been no change in the accessibility tree for Window: "` 这条**精确前缀**
- **物理指针未被移动**
- held input 未被污染

它会拿 Computer Use 会话锁，**跑完确认锁已释放**。

---

## 7. 打包形态

```bash
bun run check:native      # 含 swift test + build:sidecars + 打包 + smoke
```

打完包后确认：
```bash
codesign -dv --verbose=4 "<app>/Contents/Resources/**/cc-haha-computer-use.app" 2>&1 | grep Identifier
```
必须仍是 `dev.cchaha.cu-helper` —— 如果变了，说明 electron-builder 重签了它，用户的两项授权会全掉。
