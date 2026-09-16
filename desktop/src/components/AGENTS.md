# 桌面端组件规范

本文提供可复用组件索引、放置规则及样式 / i18n / 无障碍 / 测试约定。按改动涉及的组件查阅对应小节，无需在每次编辑前重读全文。

规则优先级：根 `AGENTS.md` < `desktop/AGENTS.md` < 本文件。冲突时以本文件为准。

配套文档：[`desktop/docs/component-library-plan.md`](../../docs/component-library-plan.md) 记录审计证据与后续计划。

---

## 一、我要做 X，用什么

先查这张表，**不要重写一个**。

| 需求 | 用这个 | 位置 |
|---|---|---|
| 带文字的按钮 | `Button` | `ui/Button.tsx` |
| 只有图标的按钮 | `IconButton` | `ui/IconButton.tsx` |
| 转圈加载 | `Spinner` | `ui/Spinner.tsx` |
| 状态徽章 / 计数 | `Badge` | `ui/Badge.tsx` |
| 状态圆点 | `StatusDot` | `ui/Badge.tsx` |
| 复选框 | `Checkbox` | `ui/Checkbox.tsx` |
| 开关 | `Switch` | `ui/Switch.tsx` |
| 单行输入 | `Input` | `ui/Input.tsx` |
| 多行输入 | `TextArea` | `ui/TextArea.tsx` |
| 纯文本选项的下拉 | `SelectField` | `ui/SelectField.tsx` |
| 带图标 / 描述的下拉 | `Dropdown` | `ui/Dropdown.tsx` |
| 搜索框 | `SearchField` | `ui/SearchField.tsx` |
| 分段切换 / 标签页 | `SegmentedControl` | `ui/SegmentedControl.tsx` |
| 空态 | `EmptyState` | `ui/EmptyState.tsx` |
| 错误态 | `ErrorState` | `ui/ErrorState.tsx` |
| 加载态 | `LoadingState` | `ui/LoadingState.tsx` |
| 骨架屏 | `Skeleton` / `SkeletonRows` / `SkeletonCards` | `ui/Skeleton.tsx` |
| 进度条 | `Progress` | `ui/Progress.tsx` |
| 卡片容器 | `Card` | `ui/Card.tsx` |
| 对话框 | `Modal` | `ui/Modal.tsx` |
| 对话框 + 一排按钮 | `ActionDialog` | `ui/ActionDialog.tsx` |
| 确认 / 删除确认 | `ConfirmDialog` | `ui/ConfirmDialog.tsx` |
| 移动端底部弹层 | `MobileBottomSheet` | `ui/MobileBottomSheet.tsx` |
| 悬浮提示 | `Tooltip` | `ui/Tooltip.tsx` |
| 复制按钮 | `CopyButton` | `ui/CopyButton.tsx` |
| 目录选择 | `DirectoryPicker` | `composite/DirectoryPicker.tsx` |
| 「用 X 打开」菜单 | `OpenWithMenu` | `composite/OpenWithMenu.tsx` |
| 品牌标记 cc-haha | `BrandSeal` | `composite/BrandSeal.tsx` |

### 两个 hook

| 需求 | 用这个 |
|---|---|
| 点外面 / Esc 关闭浮层 | `hooks/useDismissable.ts` |
| 浮层贴着触发器定位（含翻转、夹取） | `hooks/useAnchoredPosition.ts` |

**不要再手写 `document.addEventListener('mousedown', ...)`。** 触屏上 `mousedown` 不可靠，这是 H5 上「点外面菜单不关」的根因类别。`useDismissable` 默认用 `pointerdown`。

浮层开在 `Modal` 里时传 `stopEscapePropagation: true`，否则一次 Esc 会把下拉和对话框一起关掉。

### 明确不做的

`Table`（全库 0 个 `<table>`，表格数据都用 CSS Grid）、`Divider`（`divide-y` 够用）、`Avatar`（`market/SkillAvatar` 已有）、虚拟滚动库（会破坏「虚拟化项禁用 content-visibility」的不变量）。

---

## 二、新组件放哪

```
components/ui/         无业务语义的原语。禁止 import stores/ 和 api/
components/composite/  业务复合件。可 import stores/api，但必须 ≥2 个调用方
components/<feature>/  功能目录。单调用方的组件一律放这里
```

决策树：

1. **只有一个调用方？** → 放调用方所在的功能目录，不要放 `ui/` 或 `composite/`。
   > `composite/contract.test.ts` 对每个文件断言 ≥2 个调用方，单调用方会红。
2. **需要读 store 或调 API？** → `composite/`（且要有 ≥2 个调用方）。
3. **纯 UI、无业务语义？** → `ui/`。
   > `ui/contract.test.ts` 断言：不 import stores/api、不 import 其他功能目录、不含硬编码 hex、不用 `rounded-md` 之类的 Tailwind 圆角。

`shared/` 和 `common/` 已删除，**不要重建**。它们的问题是名字没有约束力：两个目录同一个 commit 建的，划分标准从没写下来，一年后各自塞满了原语和业务件的混合物，35% 是单调用方的伪公共件。上面三条规则是唯一的区别，也是 CI 能检查的部分。

**import 一律用 `@/` 别名**：`import { Button } from '@/components/ui/Button'`。

---

## 三、样式

### 3.1 颜色只能来自 token

```tsx
// 对
className="bg-[var(--color-surface)] text-[var(--color-text-primary)]"
// 错：三个主题下长得一模一样
className="bg-[#FAF9F5] text-[#1B1C1A]"
```

三个主题（`white` 默认 / `light` / `dark`）靠 `<html data-theme>` 切换，**不跟随操作系统**。新增 token 必须在三个主题块里都定义，`globals.test.ts` 会检查。

`tokenUsage.test.ts` 扫描全部源码，断言每个 `var(--token)` 都能解析 —— 拼错的 token 不会报错，只会静默渲染成透明背景或 `currentColor` 边框。

### 3.2 状态色成对使用

语义色是成对的：`--color-<tone>-container` 是底色，`--color-on-<tone>-container` 是它上面的文字色。**不要拿 `--color-warning` 直接当 `--color-warning-container` 上的前景** —— light 主题下那样只有 2.66:1，远低于 AA 的 4.5。

`contrast.test.ts` 对三主题 × 六个 tone 计算实际对比度并断言 ≥4.5（dark 的 container 是半透明的，测试会先与 surface 合成再算）。

### 3.3 圆角

用 `rounded-[var(--radius-md)]`，不要用 `rounded-md`。二者同名不同值（Tailwind 的 `rounded-lg` 是 8px，`--radius-lg` 是 12px），混用是全库 21 种圆角的来源。

### 3.4 层级

z-index 只能来自 `globals.css` 的层级刻度：

```tsx
className="z-[var(--z-dropdown)]"
style={{ zIndex: 'var(--z-dialog)' }}
```

顺序：`base 0 → raised → sticky → nav → scrim → drawer → dialog 60 → sheet 65 → dropdown 70 → popover 75 → tooltip 80 → toast 90`

两条刻意的排序：**dropdown 高于 dialog**（模态对话框挡住了背景，所以打开的下拉必然属于最上层对话框 —— 这是 `DirectoryPicker` 当初被迫写 `zIndex: 9999` 的原因），**toast 高于 sheet**（否则在 sheet 里操作，结果反馈用户看不见）。

`tokenUsage.test.ts` 拒绝任何裸 `zIndex: 9999` 或 `z-[10000]`。

### 3.5 `dark:` 变体

可以用，它绑在 `[data-theme="dark"]` 上（见 `globals.css` 顶部的 `@custom-variant dark`）。**但优先用 token** —— `dark:` 只覆盖三个主题中的一个，white 和 light 会共用同一套值。

### 3.6 className 覆盖不保证生效

组件不做 Tailwind 冲突消解（那需要 `tailwind-merge` 依赖，本项目不引 UI 依赖）。`<Button size="sm" className="px-3">` 里 `px-2` 和 `px-3` 谁赢取决于它们在生成样式表里的先后，不是 class 属性的顺序。

**如果你发现自己反复用 className 覆盖同一组工具类，那说明缺一个 variant，去加。**

### 3.7 遇到组件表达不了的样式怎么办

**不要用 className 硬压过去，也不要退回手写 `<button>`。** 正确顺序是：

1. 先确认这不是"这处本就该定制"。列表项、树节点、标签页项、拖拽把手、OS 窗口按钮这些本来就不该塞进通用组件。
2. 如果是通用需求（同样的形态在多处出现），**给组件加一个 variant/tone/size**，连同测试一起。
3. 在当前任务范围内补齐需要的组件能力，并验证调用方、交互和主题效果。只有缺少必要的产品决定或超出授权范围时才请求确认；无法完成的部分说明具体 blocker。

`IconButton` 的 `secondary` tone、`2xs`–`2xl` 六档尺寸、`bordered`、`solid`、`hoverTone="danger"`、`pressed`、`surface="sidebar"`、`surface="terminal"`（墨色终端标题栏，纸主题下 `--color-text-tertiary` 在其上不可见），`Button` 的 `base`(h-8)、`inverse` 与 `tonal-outline`（陶土描边 hover 反色）变体，`Card` 的 `shadow`/`lift`/`container` 档与 rest 透传，`Badge` 的 `wrap`/`title`/rest 透传，`SearchField` 的 `clearLabel` 与 `xl`(44px) 档 —— 全部来自这个流程。多轮独立的替换工作各自撞到同一批缺口，然后一次补齐。

几个存在理由值得记住：

> **`hoverTone="danger"`** — 删除类图标静止态就是红的，会被读成"当前处于错误状态"。静止用 `muted`，悬停才变红。
>
> **`surface="sidebar"`** — 侧边栏有自己的 hover token（`--color-sidebar-item-hover`），三个主题下都与 `--color-surface-hover` 不同。用 className 覆盖会变成两个 `hover:bg-[…]` 打架，谁赢取决于样式表顺序。
>
> **`solid` vs `filled`** — `filled` 只是浅色着色，压在用户上传的图片上会糊掉。`solid` 是满强度填充 + 对比前景（走 `--color-on-error` 这类 token，**不要写 `text-white`** —— dark 主题的 `--color-error` 是浅红，白字读不出来）。
>
> **`2xl`(44px)** — 移动端主要触摸目标的平台下限。`ChatInput` 的输入栏按钮有测试钉死这个尺寸，缩到 40px 是回归。
>
> **`SearchField` 的 `clearLabel`** — 组件内部一度用 `` `Clear ${label}` `` 拼英文，导致任何已经翻译过清除按钮的调用方采用它反而是 i18n 退化。**组件库自己不许拼用户可见的英文。**

---

## 四、桌面端硬约束

- **不引 UI 依赖。** 2026-07-25 刚回滚过 shadcn/ui。
- **不用 `/N` alpha 修饰符做关键配色**（`bg-[var(--x)]/10`）。它会编译成 Safari 15 WebView 无法解析的颜色函数，`vite-config.test.ts` 对 `globals.css` 有整文件断言。需要浅底色就加实色 token（例如 `--color-brand-soft`）。
- **不加 barrel `index.ts`。** 项目零先例，且会阻碍 tree-shaking。
- **`content-visibility` 写进 CSS class，不要写内联 style** —— 内联会绕过针对触屏 H5 的关闭覆盖。
- 同一份 bundle 服务 Electron 壳 / 桌面浏览器 / 手机 H5。触屏专属样式收敛在 `html[data-touch-h5]` 作用域下。
- **会被浮层锚定的组件必须 `forwardRef`。** `Tooltip` 和 `Dropdown` 都会给 trigger 挂 ref；不转发 ref 的组件会让 tooltip 定位不到、下拉关闭后焦点丢失，且**只有一条 console 警告**，不会报错。

---

## 五、i18n

所有用户可见文案走 `useTranslation()`，包括 `aria-label` 和 `title`。

组件库内部不写中文或英文字面量 —— 默认文案（如 `ConfirmDialog` 的按钮文字）由调用方传入。

---

## 六、无障碍基线

新组件必须满足：

- **可聚焦元素有可见 focus ring**：`focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]`
- **图标按钮有名字**：用 `IconButton`，它的 `label` 是必填的
- **输入控件有关联 label**：用 `useId()` 生成 id，**不要从 label 文本派生** —— 中文没有空格，两个中文 label 会撞 id，导致一个 `<label>` 指向另一个字段的输入框
- **错误信息有 `role="alert"`，且被 `aria-describedby` 指向**
- **浮层用正确的 role**：`role="listbox"` 里放 `role="option"`，不要放 `<button>`
- **tooltip 用 `aria-describedby` 而非 `aria-label`** —— 后者会覆盖元素本身的名字，让图标按钮被读成它的提示文字而不是它的动作
- **描述文字不要混进可访问名**：`<label>` 同时包着标题和描述时，用 `aria-labelledby` 精确指向标题那个 span

---

## 七、测试

新组件必须有对应的 `.test.tsx`。三个可复制的模板：

```tsx
// 1. 无障碍契约
it('names the button for screen readers from label', () => {
  render(<IconButton icon={<span />} label="Open settings" />)
  expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument()
})

// 2. props 矩阵
it.each(SIZES)('pins an explicit height for size=%s', (size) => {
  const { container } = render(<Button size={size}>Label</Button>)
  expect(container.firstElementChild?.className).toMatch(/\bh-\d/)
})

// 3. 回归锚点：注释写清楚原来坏在哪
it('defaults to type="button" so it cannot submit a surrounding form', () => {
  render(<Button>Run</Button>)
  expect(screen.getByRole('button', { name: 'Run' })).toHaveAttribute('type', 'button')
})
```

**jsdom 的三个已知偏差**，别在这上面浪费时间：

- `fireEvent.click` 在 `disabled` 的 `<input>` 上**仍会**触发 change（连裸 input 都如此）。断言 `toBeDisabled()`，不要模拟点击。
- 没有实现 `scrollIntoView`。源码里用可选调用 `?.scrollIntoView?.()`。
- `getBoundingClientRect` 一律返回全 0。要测定位逻辑，用 **ref callback** 打桩 rect —— 它在 DOM 挂载时同步执行，早于测量用的 layout effect；写在渲染函数体里就晚了一帧。

**测试用真实 DOM 元素做 trigger 会漏掉一整类 bug。** 浮层组件的测试里至少要有一例传**函数组件**（`<Button>` 而不是 `<button>`）—— ref 转发失败只在这种情况下暴露。

**单元测试测不到的，去开 gallery**：

```bash
cd desktop && bun run dev
```

打开 `http://localhost:1420/gallery.html`。它渲染全部 `ui/` 组件，右上角切三个主题。颜色是否可读、浮层是否盖对、进场动画是否真的在动 —— 这些只有渲染出来才知道。新增组件请同步加进 `src/dev/ComponentGallery.tsx`。

> gallery 只在 dev 下可达，不进生产构建（vite 的 build input 只有 `index.html`）。

---

## 八、验证与交付

迭代时运行相关组件测试；最终按根规则运行 `bun run check:impact` 选中的检查。`bun run check:desktop` 已包含 lint、完整 test 和 build，不必先重复跑一遍 lint / test。需要 PR-ready 或完整验证时使用 `bun run verify`；没有后续改动或未解决风险时，已通过的检查无需重跑。

自查清单：

- [ ] 没有新建与第一节表格重复的组件
- [ ] 新组件放在正确目录（第二节决策树）
- [ ] 颜色、圆角、层级都来自 token
- [ ] 有 focus ring；图标按钮有名字；输入控件有 label
- [ ] 有对应测试，且浮层组件测过函数组件 trigger
- [ ] 视觉改动在 gallery 里三个主题都看过
