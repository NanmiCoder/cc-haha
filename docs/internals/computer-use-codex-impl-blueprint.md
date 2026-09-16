---
title: Codex 原生 Computer Use 兼容契约
nav_title: Codex 兼容契约
description: 官方插件、原生事件、动作时序与批量观察的已验证契约，以及当前实现的兼容边界。
order: 15
---

# Codex 原生 Computer Use 兼容契约

macOS 原生 Computer Use 以官方 Codex 安装包中的插件、JavaScript 客户端和原生服务为兼容基准。本页说明已经验证的调用与事件契约，帮助源码读者区分底层输入、观察和模型调度。第三方复刻不再作为官方行为的规格来源；接口相似或单个任务成功，也不能证明完整兼容。

## 参考版本与分层

当前契约来自 2026 年 9 月 9 日检查的官方构建：

| 组件 | 版本或位置 |
| --- | --- |
| Computer Use 插件 | `openai-bundled/unified-computer-use/26.901.51231` |
| 原生服务 | `SkyComputerUseService`，版本 `26.831.1000926` |
| 原生服务 SHA-256 | `25e9141499b94c396f39afbdb7b19ed8f49e45dc8c61be61028ceab8f3807ce6` |
| 插件缓存 | `${CODEX_HOME}/plugins/cache/openai-bundled/unified-computer-use/<version>/` |
| App 内 JavaScript 包 | `Contents/Resources/cua_node/lib/node_modules/@oai/cua` 和 `@oai/sky` |
| 本地原生服务 | `${CODEX_HOME}/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService` |

这些版本是契约的适用范围，升级后需要重新核对调用方与实现方。原生函数地址只适用于该二进制，细节记录在源码目录的 `native/cu-helper/README.md`。

原生 App 操作经过以下链路：

```text
持久 JavaScript 会话中的 cua App 对象
  → @oai/cua / @oai/sky 客户端
  → 本地持久 IPC
  → SkyComputerUseService
  → AX 查询或面向目标进程、窗口的合成事件
```

浏览器 Tab provider 是另一条链路。安装了浏览器扩展，不代表每次操作 Chrome 都在使用 DOM：`cua.getApp(...)` 获得的原生 App 对象可以直接发送坐标点击和拖拽。判断执行方式应看实际调用的对象、方法与传输路径。

macOS 的原生 App 路径允许控制 Chrome 等浏览器，同时保留其他应用限制、授权、签名和进程身份校验。此前 TypeScript 分发与原生 `AppTargetPolicy` 都会因浏览器类别拒绝目标，阻断这条合法的原生路径；两层现在采用一致的浏览器原生控制策略。Windows 原有浏览器类别与权限等级不变。允许浏览器作为原生 App，不会提供 Tab 绑定、DOM 节点或 Playwright 方法。

Townscaper 的指定成功轨迹说明了这个区别：21 次 JavaScript 调用中，先有一次浏览器清单读取和一次超时的 `getTab`，随后绑定 Chrome 原生 App。全部 57 次输入都来自该 App：47 次拖拽、3 次点击、3 次滚动、3 次按键和 1 次粘贴，返回 18 张截图。6 个含循环的调用共执行 41 次拖拽，其中循环体执行 39 次，另外 2 次是循环外的调色板操作；没有成功的 Tab、DOM 或 Playwright 建造调用。这个案例的连续建造能力来自原生 App 路径；独立浏览器 provider 不属于本次兼容范围。

公开的 Codex CLI 和 App Server 源码包含 MCP 集成、工具调度及消息处理，但不包含这份原生服务的鼠标事件实现。官方安装包提供可读的 JavaScript 客户端；原生契约还需要结合导出符号、实际调用参数和机器码核验。不能因为静态导入表缺少某个 CGEvent 符号，就断言它只使用 AX：服务会通过动态解析后的函数指针发送事件。

## 应用发现与原生接口

原生应用限制按已解析的 bundle ID 精确匹配官方 24 项禁止目标，另保留本产品宿主和 helper 的固有限制。此前第三方表中的 IDE、音乐、交易分类及显示名子串不再参与 macOS 原生判断。发现列表仍可包含禁止目标，真正绑定或动作时才执行授权检查。

`cua.listApps()` 合并正在运行的普通 App 与 Spotlight 中最近 14 天使用过的 App，保留 `id`、`displayName`、`isRunning` 及可选的 `lastUsedDate`、`useCount`。`id` 来自 bundle ID，不等于绑定后的规范路径；结构化数据跨 helper、分发器及 worker 原样传递。旧 helper 仅返回运行列表时仍兼容。低层原生窗口 API 也可通过 `cua.computer` 的 11 个 snake_case 方法访问，同样经过授权和进程校验。

## 坐标拖拽的五事件契约

官方 `app.drag()` 经原生坐标控制器，将起点和可选拖拽终点传给 `ApplicationUIElement.sendClick`。底层 `SynthesizedEvent.click` 生成以下事件，窗口绑定在整个手势内保持一致：

| 顺序 | 事件 | 位置 | clickCount | eventNumber |
| --- | --- | --- | --- | --- |
| 1 | mouseDown | 起点 | 1 | 手势编号 |
| 2 | mouseDragged | 起点 | 0 | 移动编号 |
| 3 | mouseDragged | 起终点的中点 | 0 | 同一移动编号 |
| 4 | mouseDragged | 终点 | 0 | 同一移动编号 |
| 5 | mouseUp | 终点 | 1 | 同一手势编号 |

起点等于终点时仍保留五个事件，不能折叠成普通点击。按下后的起点 dragged 事件也不能省略。普通点击的事件对与拖拽的移动事件具有不同语义，不能用任意插值步数替代这个契约。

原生服务通过 AppKit 构造鼠标事件，取得 CGEvent 后写入目标窗口信息、全局和窗口内位置，再发送到目标 PID。这既不是单纯调用 AXPress，也不是移动用户的真实鼠标后在前台点击。坐标转换、窗口身份和进程生命周期必须在同一条链路上成立，不能只用相似窗口标题绑定截图与输入。

对应实现集中在 `native/cu-helper/Sources/cu-helper/AXAction.swift`、`WindowTargetedEvent.swift` 和 `WindowGeometry.swift`。`MouseDragEventTests` 使用生产事件工厂验证事件顺序、坐标、编号和窗口绑定。

## 键盘输入

原生接收窗口验证了 `Control_L/R`、`Super_L/R`、`Meta_L/R`、`Shift_L/R` 和 `Alt_L/R` 的实际修饰键行为。键名 `Delete` 对应向前删除的 keyCode 117，`BackSpace` 对应 51；大写字母和 `question` 等具名符号必须保留 Shift。解析器与系统组合键授权检查同时识别这些别名。

## 滚动页数与目标区域

官方原生 `scroll` 发送精确像素滚轮事件，保留小数页数。通过元素索引滚动时，垂直页数乘以该元素的外框高度；通过坐标滚动时，乘以当前窗口高度，不改用坐标下的滚动区。实测同一 210 点高滚动区，元素方式滚动 0.5、1.5 页分别收到 -105、-315；在 552 点高窗口中，坐标方式滚动 0.5 页收到 -276，向上则为 +276。不能将这些请求舍入为整页 AX 动作，或固定换成 12 行滚轮事件。显式 `performSecondaryAction` 的 Scroll Down 等动作仍采用该控件公开的 AX 页操作语义。

当前官方版本的水平调用传入单轴滚轮事件，实测横向增量被忽略。本实现保留双轴水平滚动能力；这是明确记录的行为差异，不复制该无效操作。

滚轮事件同时设置窗口字段 51、91、92 和窗口内坐标。只有 91、92 不能建立 AppKit 的 `windowNumber`，会造成事件构造成功但目标收不到。实际接收端验证了字段 51 修复后的精确像素滚动。非整数距离按最近整数取整，例如 210 × 0.123 点产生 26 像素增量。

`performSecondaryAction` 的四个翻页方向优先读取 `AXVerticalScrollBar` 或 `AXHorizontalScrollBar`，从滚条的 `AXChildren` 中找到首个角色为 `AXButton`、子角色为 `AXDecrementPage`（上/左）或 `AXIncrementPage`（下/右）的节点，并执行 `AXPress`。缺少滚条或按钮时才尝试目标的原始 `AXScroll*ByPage` 动作；按钮执行失败则传播错误，不重发。`AXIncrementPage` 和 `AXDecrementPage` 是子角色值，不是可查询的属性名。页距由控件决定，不写死像素数。

## 粘贴消费确认与时序

原生粘贴的两秒是读取超时上限，不是每次必须等待的时长。写入临时内容之前，先捕获目标进程当前输入框支持的 `AXSelectedTextRange`、`AXNumberOfCharacters`，并监听该元素的选区和值变化。内容写入后才启用通知计数；数据提供回调成功供给字节后，第一阶段即可结束。

第二阶段最多等两秒，每 25 毫秒检查目标。只有读取后发生的目标通知或有效属性变化才支持提前返回，不能把其他剪贴板观察者的读取当成目标消费确认，也不能把 AX 读取失败当成值变化。完全没有可观察信号时，读取后保留 100 毫秒窗口。有信号但一直没有变化时会报目标确认超时；已执行的粘贴不重放。取消后仍完成当前有界消费窗口再恢复，外部复制始终优先，只有仍持有临时内容时才恢复旧剪贴板。

接收端确定性回归使用独立 named pasteboard，保留真实 Router、Command-V、菜单、数据提供、目标 AX 确认和恢复。它隔离共享数据源，不等于正式 general 剪贴板链的全环境验收。

## 截图尺寸与格式

官方原生状态截图默认归一到逻辑点尺寸，再限制长边为 2048、短边为 768，不放大小图，最终像素尺寸向上取整，JPEG 编码质量为 0.8。1398 × 769 点的窗口因此返回 1397 × 768 像素；这是缩放结果，不是裁掉窗口边缘。坐标转换保留完整窗口 frame，并使用取整前的统一 `pixelsPerPoint` 比例；不能按取整后的横纵尺寸各算一个比例，也不能修改窗口边界。旧快照未提供统一比例时保留原有转换方式。

原生结果的 `mimeType` 随图片跨分发与 worker 传递。旧 helper 未提供该字段时仍按 PNG 处理。官方包装器曾把真实 JPEG 字节标记为 PNG；本实现保留正确的 JPEG MIME 标签，避免模型请求端误解内容。

## 动作时序与可见光标

已检查的坐标点击、拖拽调用明确传入 `delay: nil`。直接发送和虚拟光标发送两条分支都跳过可选 sleep，因此没有每事件固定 30 ms 的等待，也没有固定 100 ms 的按住时间。服务中的 `humanClickInterval` 常量用于其他明确的点击或 press 路径，不能套用到坐标拖拽。

虚拟光标分支同步更新按下状态并发送事件。坐标点击、拖拽路径没有在发送前等待光标移动动画完成。专用 `moveMouse` 操作具有自己的动画和后续交互时机，属于不同调用路径。光标需要让用户看见操作，但不应额外给每次坐标手势附加固定的可见等待。

机器码中存在 Swift executor 切换，这不保证每次都会暂停或产生确定的事件间隔。因此不能为了模拟它，另加猜测的 sleep 或 `Task.yield`。本项目取消的是已确定多余的固定等待，仍保留事件发送前的目标校验、取消检查和异常后的抬键清理。

焦点准备和纯视觉等待也要分开。`SyntheticWindowFocus` 保留进程生命周期、焦点变化和输入确认检查；已建立的焦点状态可以复用，真正需要建立或恢复焦点时才等待确认。删除所有焦点检查并不构成兼容性优化。

## 批量动作与观察

官方原生 App API 可以在持久 JavaScript 会话里保留 App 绑定、计算坐标并循环调用动作。一个工具调用可以连续执行多个已确定动作，最后才读取 AX 状态或截图。循环中的 `await app.drag()` 等待本地动作完成，不要求模型在每个动作之间重新生成一次回答。

原生坐标控制器仅在 `returnSkyshot: true` 时进入 UI settle 和截图分支；false 标记状态需要刷新后直接返回。已核验的 settle 调用包含 250 ms 的通知延迟参数，但这不是每次动作无条件 sleep 250 ms，更不是完整截图耗时的保证。不能把“每次变更后自动重截图”当成官方的固定行为。

macOS 向模型公布的工具只有 `js` 和 `js_reset`，减少重复的逐动作 schema。`js` 提供持久变量、App 绑定、顶层 `await`、循环和同次调用内的计算与观察。worker 内的 `cua` 原生 App 方法通过 JSON 消息回到主进程，再进入已有语义工具的权限、进程身份和窗口校验；脚本中的 App 对象不能绕过这些检查。`cua.getApp()` 初次观察显示 AX 文本，首次可见的 App 选择或状态清单同时显示简短 API 说明。App 绑定使用主进程返回的已解析路径，后续动作仍重新校验目标。

`app.getAXState()`、`app.getScreenshot()` 和 `app.getAXStateAndScreenshot()` 分别返回、展示文本、图片或两者；`emit: false` 保留返回值并抑制展示。已核验的官方 JavaScript 实现也将三个方法都转为 `get_app_state`，因此这种输出分离不代表跳过 AX 遍历或截图。动作本身不自动观察，脚本在需要决定下一步时显式请求状态。

元素的底层句柄仍是 `gN:id`。兼容层只把实际返回过的 AX 行映射为整数索引，处理差异中的新增、变更和删除，并在世代改变时清空旧映射。只取图片的请求也可能刷新原生状态，所以会清空整数映射；再次使用整数前应调用 `app.getAXState({disableDiffing: true})`。直接使用复制的句柄仍须通过原生校验。

| 每个 `js` 调用的限制 | 数值 |
| --- | --- |
| 原生调用 | 最多 256 次，包含观察 |
| 代码 | 最多 256 KiB |
| 展示输出 | 最多 128 块、合计 16 MiB |
| 超时 | 默认 30 秒，最多 60 秒 |

跨 cell 的变量通过共享词法访问器连接，旧函数与新脚本读取同一绑定。重新选择 App 后，此前定义的函数会使用新 App；先定义函数、下一 cell 再声明其引用的 App 也可用。局部参数、块作用域、解构及类内部绑定保持自身语义，不能为了持久化而复制每次调用的变量值。

普通脚本错误保留可恢复的既有绑定和已经执行的声明或直接写入；失败脚本中尚未执行的 `var/function` 声明不会仅因变量提升而留下额外绑定。重绑 App 的初始化失败时，旧 App 绑定仍可用。`js_reset`、取消或超时会丢弃 worker 及其绑定。已经执行的动作不回滚，重新绑定后必须先观察，再判断部分完成的工作是否需要继续。当前 worker 不开放 imports、Node、文件系统或网络接口。执行和隔离边界位于 `src/utils/computerUse/replRuntime.ts`、`replWorker.ts` 与 `replCompiler.ts`；原生方法及观察输出适配位于 `src/vendor/computer-use-mcp/replApi.ts`。

有确切对应关系的原生错误保留 `SkyComputerUseError` 的 `name`、`code`、`errorName` 和请求字段；不能确定官方分类的 helper 错误仅保留原始 `nativeCode`，不从消息猜测错误码。权限或参数检查在派发前拒绝时，单独计入 `nativeCallsRejectedBeforeDispatch`，不会报成已经完成的动作或未知执行结果。超时及可能发生部分副作用的错误仍保留结果未知语义，不自动重放。

桌面使用合并 sidecar 可执行文件。它必须在解析普通运行模式、`app-root` 或加载 `preload` 之前识别内部 worker 参数，直接启动隔离 kernel。只在 CLI 子入口处理该参数会让实际桌面程序提前报错；源码 worker 或手写编译入口测试无法覆盖这个边界。worker 的 HOME 和临时目录均指向可丢弃目录，沙箱内部重新指定临时目录变量，避免包装库覆盖它们。

旧的 `sequence` 保留为同一 App 的 JSON 批量兼容入口，顺序执行后观察一次，并在失败或取消时报告已完成步骤。它最多接受 256 步，使用协作式 60 秒截止时间；正在执行的原生命令必须结束后才能返回。独立语义工具也保留直接调用兼容，但这些接口不再默认展示给模型。Windows 继续使用原有像素工具，没有新增这组 JavaScript 接口。

是否适合批量执行取决于界面是否稳定。已经验证有效的画布动作可以连续提交；打开菜单、切换窗口或其他会改变后续目标的动作，应在新的决策点重新观察。衡量速度时应分别记录动作数、观察次数、模型往返、工具耗时和目标 App 实际完成的结果。

## 当前兼容边界

五事件工厂测试验证事件构造。原先向临时原生 App 连续发送拖拽的集成测试已移除，避免常规测试打开窗口并操作 macOS 桌面。真实 App 的手势交付需单独手动验证；工厂测试不证明 Townscaper、Blender 或所有真实任务的成功率。

针对进程身份连续性的定向回归完成了 15 轮：45 个临时 App、180 次完整拖拽和 1,095 次真实校验取样均通过。同一进程的身份字段及启动时间浮点位保持一致。曾出现的两次异常——`stale_process` 和缺少阶段记录的超时——没有重现，原因仍未定位；没有因此放宽身份比较、加入容差或自动重试。`ProcessValidationObservationTests` 保留身份诊断的回归覆盖；上述真实输入结果属于已移除测试的历史验证记录。

本兼容范围仅包含原生 Computer Use。独立浏览器 Tab、DOM provider 与通用 Node 能力不在范围内。worker 的真实子进程测试使用临时目录和模拟原生工具，证明隔离、持久化及输出边界；原生接收端测试证明事件交付。两者都不能替代真实模型任务的成功率评估，也不能推出所有真实 App 的行为已经一致。

AX 树格式、元素重定位、焦点、键盘输入、窗口坐标、截图和光标动画各有独立契约。本页没有为尚未核验的部分指定推测算法或第三方常量。后续兼容工作应沿真实调用链补齐证据，再将确定行为落实到相应源码与回归测试。
