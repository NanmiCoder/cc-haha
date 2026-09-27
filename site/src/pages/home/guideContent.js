import sessionZh from '../../../../docs/images/app/zh-CN/session-new.webp'
import settingsZh from '../../../../docs/images/app/zh-CN/settings-computer-use.webp'
import sessionEn from '../../../../docs/images/app/en/session-new.webp'
import settingsEn from '../../../../docs/images/app/en/settings-computer-use.webp'
import workspaceZh from '../../../../docs/images/app/zh-CN/workspace-diff.webp'
import workspaceEn from '../../../../docs/images/app/en/workspace-diff.webp'

export const guideContent = {
  zh: {
    eyebrow: 'cc-haha / 开源使用指南',
    title: '让第一件事真正做成。', titleLines: ['让第一件事', '真正做成。'],
    intro: '给它一个目标，Agent 在代码与应用之间完成任务；你审阅每一步。macOS 的 Computer Use 不占用真实鼠标和键盘。',
    mobileIntro: '一句话交代任务，Agent 帮你写代码、操作应用；过程和改动随时可审阅。macOS 上的 Computer Use 不占用真实鼠标和键盘。',
    primary: '从 0 到 1 开始', secondary: '先看真实案例', note: '从下载到第一条会话 · 约 20 分钟',
    showcaseLabel: '查看产品界面',
    showcase: [
      { label: '写代码', window: '新建会话', kicker: '01 / 开始', title: '一句话，交代清楚任务。', body: '选好项目、模型与权限，从一条真实会话开始。', alt: 'cc-haha 新建会话界面', href: '/start/first-session', action: '查看首次会话教程' },
      { label: '操作应用', window: 'Computer Use', kicker: '02 / 特色能力', title: '让 Agent 走出代码编辑器。', body: 'macOS 原生操控其他应用，真实鼠标和键盘仍归你使用。', alt: 'cc-haha 的 Computer Use 设置界面', href: '/desktop/computer-use', action: '查看 Computer Use 指南' },
      { label: '审阅改动', window: '工作区', kicker: '03 / 交付', title: '看清每一处修改。', body: '从调用记录到文件差异，检查结果后再决定下一步。', alt: 'cc-haha 工作区差异审阅界面', href: '/desktop/workspace', action: '查看工作区指南' }
    ],
    thesis: '先完成一件事，再理解每一个开关。',
    thesisBody: '不需要先读完所有功能。照着路径装好应用、接上模型、完成首次任务；遇到具体需求，再查设置和案例。',
    chapters: [['01', '认识', '它是什么、适合做什么', '/start'], ['02', '上手', '安装、连接模型、完成会话', '/start/first-session'], ['03', '配置', '从常用设置到进阶能力', '/desktop/settings'], ['04', '实战', '跟着任务复现工作流', '/cases']],
    routeLabel: '01 / 阅读路线', routeTitle: '你现在想做什么？', routeBody: '选一个最贴近你眼前任务的入口。每条路都有明确的下一步。',
    routeTrailLabel: '首次任务的四个步骤', routeTrail: ['下载', '连接', '交代任务', '审阅 Diff'],
    routes: [
      ['第一次来', '先跑通一条会话', '下载应用，选一种模型接入方式，在一个小项目里完成一次可验证的改动。', '/start/first-session', '开始入门教程'],
      ['有个问题', '按症状找设置', '权限、网络、回复语言、搜索、通知、数据目录等选项，解释何时需要改、改完影响哪里。', '/desktop/settings', '打开设置指南'],
      ['要做实事', '照着案例做一遍', '从理解陌生项目、修复 Bug，到交付功能、自动复查和手机接力。', '/cases', '浏览实战案例']
    ],
    pathLabel: '02 / 第一次交付', pathTitle: '四步，从空白到第一个结果。',
    steps: [['下载应用', '按系统选择安装包，打开桌面端。', '/start/install'], ['连接模型', '用官方账号、API 服务商或本地模型接入一种即可。', '/start/models'], ['给出任务', '选项目目录，保持「询问权限」，描述一个能检查结果的小目标。', '/start/first-session'], ['审阅结果', '查看工具调用和 Diff，确认文件与验收结果。', '/desktop/workspace']],
    sessionCaption: '真实界面 / 新建会话：项目、权限与模型都在输入框附近。',
    casesLabel: '03 / 实战案例', casesTitle: '学会一种做法，再换成你的任务。', casesBody: '每个案例都从材料、步骤和可复制的任务描述开始，最后给出检查结果的方法。',
    cases: [
      ['先理解', '接手一个陌生项目', '让 Agent 先读目录与脚本，交付一份能验证的项目地图。', '入口、启动方式、关键模块', '/cases/explore-project'],
      ['再修复', '定位并修复一个 Bug', '从复现与失败测试出发，限定改动范围，再检查回归。', '修复、测试、差异清单', '/cases/fix-bug'],
      ['做功能', '交付一个小功能', '把目标、约束、验收条件说清楚，逐轮审阅实现。', '可运行功能与验证记录', '/cases/ship-feature'],
      ['养成流程', '让定时任务每天复查', '把重复检查交给定时任务，在独立会话里留下结果。', '每日检查记录', '/cases/daily-review']
    ],
    allCases: '查看全部案例与技巧',
    settingsLabel: '04 / 配置地图', settingsTitle: '开关很多，先知道该去哪找。', settingsBody: '常用配置按问题归类。每一项的默认值、使用场景和影响范围，都在设置指南里展开。',
    settings: [['先能用', '服务商 · 模型 · 默认权限', '连上模型，决定 Agent 每一步能做什么。'], ['用得顺', '主题 · 语言 · 输出风格 · 快捷键', '让界面和回答适合你的习惯。'], ['连得稳', '代理 · 超时 · WebSearch · WebFetch', '排查请求慢、搜索不可用和网络限制。'], ['扩展工作流', 'Skills · Agents · MCP · 定时任务 · Computer Use', '让一次性的任务变成可复用的能力，在 macOS 上还能操控其他应用。']],
    settingsLink: '逐项查看设置说明', settingsCaption: '真实界面 / Computer Use：macOS 原生控制，不占用真实鼠标。',
    closingTitle: '从一个小任务开始。', closingBody: '先拿一个可以回退的项目练手。等你完成第一次交付，再把案例换成自己的工作。',
    footer: '开源、本地优先的 AI 编程工作台。文档随产品持续更新。'
  },
  en: {
    eyebrow: 'cc-haha / OPEN GUIDE', title: 'Make the first task real.', titleLines: ['Make the', 'first task real.'],
    intro: 'Give it a goal. The agent works across code and apps while you review every step. On macOS, Computer Use leaves your physical mouse and keyboard free.',
    mobileIntro: 'Give it a task. The agent works across code and apps while you review every change. On macOS, Computer Use leaves your physical mouse and keyboard free.',
    primary: 'Start from zero', secondary: 'Explore real examples', note: 'Download to first session · about 20 minutes',
    showcaseLabel: 'Explore the product UI',
    showcase: [
      { label: 'Code', window: 'New session', kicker: '01 / BEGIN', title: 'Give it a real task.', body: 'Pick a project, model, and permission mode, then start a session.', alt: 'cc-haha new session screen', href: '/en/start/first-session', action: 'Read the first session guide' },
      { label: 'Use apps', window: 'Computer Use', kicker: '02 / DISTINCTIVE', title: 'Move beyond the editor.', body: 'On macOS, native app control leaves your physical mouse and keyboard free.', alt: 'cc-haha Computer Use settings screen', href: '/en/desktop/computer-use', action: 'Read the Computer Use guide' },
      { label: 'Review', window: 'Workspace', kicker: '03 / DELIVER', title: 'Inspect every change.', body: 'Follow tool calls and file diffs before deciding what to do next.', alt: 'cc-haha workspace diff review screen', href: '/en/desktop/workspace', action: 'Read the workspace guide' }
    ],
    thesis: 'Finish one task. Then learn the switches.', thesisBody: 'You do not need to learn every feature first. Install the app, connect one model, and complete a small task. Return to settings and examples when a need appears.',
    chapters: [['01', 'Discover', 'What it is and what it can do', '/en/start'], ['02', 'Begin', 'Install, connect, complete a session', '/en/start/first-session'], ['03', 'Configure', 'Everyday settings and advanced tools', '/en/desktop/settings'], ['04', 'Practice', 'Reproduce a complete workflow', '/en/cases']],
    routeLabel: '01 / YOUR ROUTE', routeTitle: 'What do you want to do now?', routeBody: 'Pick the route closest to your task. Each has a clear next step.',
    routeTrailLabel: 'Four steps to your first task', routeTrail: ['Install', 'Connect', 'Assign', 'Review diff'],
    routes: [['New here', 'Complete one session', 'Install the app, connect a model, and make one verifiable change in a small project.', '/en/start/first-session', 'Follow the first session'], ['Something is off', 'Find the right setting', 'Learn when to change permissions, network, reply language, search, notifications, and storage.', '/en/desktop/settings', 'Open the settings guide'], ['Ready to work', 'Try a real example', 'Explore a codebase, fix a bug, ship a feature, run daily reviews, or continue from your phone.', '/en/cases', 'Browse the examples']],
    pathLabel: '02 / FIRST DELIVERY', pathTitle: 'Four steps to a first result.',
    steps: [['Install', 'Choose the package for your system and open the desktop app.', '/en/start/install'], ['Connect a model', 'Use an official account, an API provider, or a local model.', '/en/start/models'], ['Give it a task', 'Choose a project, keep Ask permission, and describe a verifiable goal.', '/en/start/first-session'], ['Review the result', 'Inspect tool calls and diffs, then check the files and outcome.', '/en/desktop/workspace']],
    sessionCaption: 'Real UI / New session: project, permission, and model controls sit by the composer.',
    casesLabel: '03 / PRACTICAL CASES', casesTitle: 'Learn the pattern. Apply it to your work.', casesBody: 'Each case starts with inputs, steps, and a copyable prompt, then shows how to check the result.',
    cases: [['Explore', 'Understand an unfamiliar repo', 'Ask the agent to read structure and scripts, then deliver a verifiable project map.', 'Entry points, start command, modules', '/en/cases/explore-project'], ['Repair', 'Find and fix a bug', 'Start from a reproduction and failing test, keep the patch scoped, then check regressions.', 'Fix, test, diff summary', '/en/cases/fix-bug'], ['Build', 'Ship a small feature', 'State the goal, constraints, and acceptance conditions, then review each iteration.', 'Working feature and verification', '/en/cases/ship-feature'], ['Repeat', 'Run a daily review', 'Turn a repeated check into a scheduled task with a separate session for each run.', 'Daily review records', '/en/cases/daily-review']],
    allCases: 'See all cases and tips',
    settingsLabel: '04 / SETTINGS MAP', settingsTitle: 'Many controls. One place to find them.', settingsBody: 'Find common settings by the problem they solve. The guide explains defaults, when to change them, and their scope.',
    settings: [['Get connected', 'Providers · models · permissions', 'Connect a model and decide what the agent can do.'], ['Make it yours', 'Theme · language · output style · shortcuts', 'Tune the interface and replies to your habits.'], ['Stay connected', 'Proxy · timeout · WebSearch · WebFetch', 'Diagnose slow requests and search or network restrictions.'], ['Extend the flow', 'Skills · Agents · MCP · schedules · Computer Use', 'Turn one-off work into reusable capabilities and control other apps on macOS.']],
    settingsLink: 'Explore every setting', settingsCaption: 'Real UI / Computer Use: native macOS control without taking over the physical mouse.',
    closingTitle: 'Start with a small task.', closingBody: 'Practice on a project you can roll back. After the first delivery, adapt the cases to your own work.',
    footer: 'An open-source, local-first AI coding workbench. This guide evolves with the product.'
  }
}

export const guideScreenshots = { zh: { session: sessionZh, settings: settingsZh, workspace: workspaceZh }, en: { session: sessionEn, settings: settingsEn, workspace: workspaceEn } }
