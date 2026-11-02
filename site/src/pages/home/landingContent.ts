export type LandingLocale = 'zh' | 'en'
export type TaskCategory = 'code' | 'apps' | 'review'
export type FeatureId = 'teams' | 'computer-use' | 'models' | 'workbench' | 'skills'

// Same targets as desktop/src/pages/settings/mobileAppLinks.ts: every desktop release carries the APK,
// and iPhone installs go through the public TestFlight group.
export const MOBILE_LINKS = {
  android: 'https://github.com/NanmiCoder/cc-haha/releases/latest',
  testFlight: 'https://testflight.apple.com/join/Nd49JrWZ'
}

export interface TaskSuggestion {
  label: string
  prompt: string
  category: TaskCategory
}

export interface LandingFeature {
  id: FeatureId
  tab: string
  title: string
  body: string
  route: string
  alt: string
}

export interface LandingContent {
  hero: {
    eyebrow: string
    // The second line ends with the accent word, which the page sets in the olive accent colour.
    headline: [string, string]
    accent: string
    // Two sentences, one per line on wide screens; the page meta joins them.
    description: [string, string]
    desktopAlt: string
    phoneAlt: string
    phoneLabel: string
  }
  downloads: {
    desktop: string
    android: string
    iphone: string
    androidLabel: string
    iphoneLabel: string
    requirement: string
  }
  mobile: {
    description: string
    abilities: { title: string; body: string }[]
    connection: string
    docs: string
    route: string
    screens: { caption: string; alt: string }[]
  }
  taskSuggestions: TaskSuggestion[]
  features: LandingFeature[]
  workflowSteps: { title: string; body: string; route: string }[]
  faqs: { question: string; answer: string }[]
  closing: { title: string; body: string }
}

export const landingContent: Record<LandingLocale, LandingContent> = {
  zh: {
    hero: {
      eyebrow: '免费开源 · macOS · Windows · Linux · Android · iOS',
      headline: ['把 Claude Code 装进桌面，', '也装进'],
      accent: '口袋。',
      description: ['多会话并行、Agent Teams、Computer Use，模型随你接。', '手机扫码连上电脑，离开工位也能审批、派任务。'],
      desktopAlt: 'cc-haha 桌面端：「给官网加更新日志页」会话写完代码，正在请求运行 bun test && npm run build',
      phoneAlt: 'cc-haha 手机 App 上的同一个请求：想运行命令 bun test && npm run build，可以拒绝或允许',
      phoneLabel: '手机 App：'
    },
    downloads: {
      desktop: '下载桌面端',
      android: 'Android APK',
      iphone: 'iPhone · TestFlight',
      androidLabel: '在 GitHub Releases 下载 Android APK',
      iphoneLabel: '通过 TestFlight 公开测试安装 iPhone App',
      requirement: '手机 App 需要桌面端 v0.7.6 或更新版本，界面目前只有中文。'
    },
    mobile: {
      description: 'Android 和 iPhone App 扫码连上你的电脑。任务一直在电脑上跑，手机负责看进度、做决定。',
      abilities: [
        { title: '审批命令', body: 'Agent 想运行命令或改文件时，在手机上允许或拒绝。' },
        { title: '回答提问', body: 'Agent 需要你拿主意时，选一个答案它就接着做。' },
        { title: '派新任务', body: '想到什么发一句话，电脑上开一个新会话去做。' }
      ],
      connection: '同一 Wi-Fi 下直接连接，外出时走 Cloudflare。电脑需要开着，cc-haha 保持运行。',
      docs: '了解手机连接',
      route: '/desktop/remote',
      screens: [
        { caption: '首页：哪些任务做完了、哪个在等你', alt: '手机 App 首页：lumen 项目的四个任务，三个已完成，一个正在等你批准运行命令' },
        { caption: '审批：电脑上的命令，在手机上放行', alt: '手机 App 审批底单：想运行命令 bun test && npm run build，可以拒绝或允许' },
        { caption: '回复：结果直接在手机上读', alt: '手机 App 会话页：模型写好的 v2.4.0 发布说明' }
      ]
    },
    taskSuggestions: [
      { label: '做一个新页面', prompt: '帮我把这个项目的首页做得更好看。先了解现有风格，再完成页面，检查手机端，并告诉我改了什么。', category: 'code' },
      { label: '让应用替我忙', prompt: '在「备忘录」里新建一条「本周计划」，写下阅读、散步和整理项目三个事项。只操作这一条笔记。', category: 'apps' },
      { label: '检查这次改动', prompt: '审阅当前项目的未提交改动，找出可能的功能问题，说明对应文件、原因和建议。先不要修改文件。', category: 'review' }
    ],
    features: [
      {
        id: 'teams',
        tab: 'Agent Teams',
        title: '一个目标，一支团队。',
        body: '把大目标交给队长：它拆分任务、指派成员，成员各自并行推进。依赖关系、进度和成员之间的消息都在同一个面板里，结束后还能回看。',
        route: '/internals/agent',
        alt: 'Agent Teams 运行报告：队长居中，四个成员并行，共享任务列表按依赖分层，两项完成、一项执行中'
      },
      {
        id: 'computer-use',
        tab: 'Computer Use',
        title: '它有自己的光标。',
        body: '开启 Computer Use 后，Agent 用独立的虚拟光标操作其他应用，你的鼠标和键盘照常使用。这是 macOS 14.4 及更新版本的原生能力；Windows 使用兼容执行器，会移动真实鼠标。',
        route: '/desktop/computer-use',
        alt: 'Computer Use 设置页：已启用，辅助功能和屏幕录制权限均已授权'
      },
      {
        id: 'models',
        tab: '多模型',
        title: '模型，随你选。',
        body: 'Claude、ChatGPT、Grok 官方账号直接登录，DeepSeek、Kimi、GLM 等常用 API 一键预设，本机的 Ollama、LM Studio 也能接。完整的 Agent 工作流需要模型支持工具调用。',
        route: '/start/models',
        alt: '输入框的模型菜单：DeepSeek、Kimi、智谱 GLM 等服务商的模型按来源分组'
      },
      {
        id: 'workbench',
        tab: '工作台',
        title: '多个任务，一个窗口。',
        body: '多个会话同时推进，内置浏览器直接预览页面，改动按文件逐个审阅、留下行级意见，都在一个桌面窗口里完成。',
        route: '/desktop/workspace',
        alt: '桌面工作台：左侧会话列表，中间是改完的对话和 5 个文件的改动，右侧内置浏览器预览新的更新日志页'
      },
      {
        id: 'skills',
        tab: '技能市场',
        title: '技能市场，装上就能用。',
        body: '浏览 ClawHub 与 SkillHub 的精选技能，来源和安全扫描状态摆在明处，一键安装。技能来自社区第三方，安装前先看一眼技能文件。',
        route: '/desktop/skills',
        alt: '技能市场：398 个精选技能，按来源、安全状态和分类筛选，卡片标明扫描通过'
      }
    ],
    workflowSteps: [
      { title: '住进你的电脑', body: '下载桌面应用，打开手边的项目。', route: '/start/install' },
      { title: '接上熟悉的模型', body: '官方账号、API 或本地模型，选择适合你的。', route: '/start/models' },
      { title: '交代一件小事', body: '说清目标与范围，选好这次任务的权限。', route: '/start/first-session' },
      { title: '看看它做得怎样', body: '检查结果，留下反馈，再决定下一步。', route: '/desktop/workspace' }
    ],
    faqs: [
      { question: 'cc-haha 免费吗？', answer: 'cc-haha 免费、开源。模型服务不包含在应用中：使用官方账号或 API 时，订阅和调用费用由相应服务商收取。也可以连接本机运行的 LM Studio 或 Ollama。' },
      { question: '我的设备能用吗？', answer: '桌面应用提供 macOS、Windows 和 Linux 安装包，支持对应的 Intel / AMD 与 ARM 架构，按下载指南选择适合系统的版本即可。手机 App 支持 Android 和 iPhone，iPhone 目前通过 TestFlight 公开测试安装。Computer Use 的平台支持有所不同，见下方说明。' },
      { question: '手机怎么连上电脑？', answer: 'Android 在 GitHub Releases 下载 cc-haha-mobile 开头的 APK；iPhone 先装 TestFlight，再打开公开测试链接加入。然后在桌面端「手机连接」里扫码配对：同一 Wi-Fi 下直接连接，外出时走 Cloudflare。手机 App 需要桌面端 v0.7.6 或更新版本，任务始终在电脑上运行。' },
      { question: '可以用我已经有的模型吗？', answer: '可以。支持通过 Claude、ChatGPT、Grok 官方账号登录，也可配置第三方 API 或连接本地模型。可用模型取决于账号权限和服务商；完整的 Agent 工作流还需要模型支持工具调用。' },
      { question: 'Computer Use 会抢我的鼠标吗？', answer: 'macOS 14.4 及更新版本的原生运行组件通过独立虚拟光标操作，不占用真实鼠标和键盘；少数操作可能改变应用焦点。Windows 的兼容执行器会移动真实鼠标。Linux 暂无执行器。启用前需要完成应用内确认及相应系统授权。' },
      { question: '我能控制 AI 改哪些东西吗？', answer: '可以选择权限模式。默认「询问权限」会在需要授权的写文件、执行命令操作前请求确认，也可以切换到仅规划等模式。编辑后可在工作区审阅差异、留下反馈。Computer Use 单独启用并确认后可操作所有受支持应用，因此也要在任务中写清范围。' }
    ],
    closing: {
      title: '下一件想做的事，交给它试试。',
      body: '从一个小任务开始，让今天多一点自己的时间。'
    }
  },
  en: {
    hero: {
      eyebrow: 'Free & open source · macOS · Windows · Linux · Android · iOS',
      headline: ['Claude Code on your desktop.', 'And in your '],
      accent: 'pocket.',
      description: ['Parallel sessions, Agent Teams, Computer Use, and any model you like.', 'Pair your phone to approve and start tasks away from your desk.'],
      desktopAlt: 'cc-haha desktop (Chinese interface): a session that added a changelog page asks to run bun test && npm run build',
      phoneAlt: 'The same request in the cc-haha phone app (Chinese interface), with Deny and Allow buttons',
      phoneLabel: 'Phone app:'
    },
    downloads: {
      desktop: 'Get the desktop app',
      android: 'Android APK',
      iphone: 'iPhone · TestFlight',
      androidLabel: 'Download the Android APK from GitHub Releases',
      iphoneLabel: 'Install the iPhone app from the public TestFlight beta',
      requirement: 'The phone app needs desktop v0.7.6 or later. Its interface is currently in Chinese only.'
    },
    mobile: {
      description: 'Pair the Android or iPhone app with your computer by QR code. Tasks keep running on the computer while your phone follows along and makes the calls.',
      abilities: [
        { title: 'Approve commands', body: 'When the agent wants to run a command or edit files, allow or deny it from your phone.' },
        { title: 'Answer questions', body: 'When the agent needs a decision, pick an answer and it carries on.' },
        { title: 'Start new tasks', body: 'Send one sentence and a new session starts on your computer.' }
      ],
      connection: 'Connect directly on the same Wi-Fi, or through Cloudflare when you are away. Your computer stays on with cc-haha running.',
      docs: 'How phone pairing works',
      route: '/en/desktop/remote',
      screens: [
        { caption: 'Home: what finished and what needs you', alt: 'Phone app home (Chinese interface): four tasks in the lumen project, three done and one waiting for approval' },
        { caption: 'Approve a command from your phone', alt: 'Phone app approval sheet (Chinese interface) for bun test && npm run build, with Deny and Allow' },
        { caption: 'Read the result where you are', alt: 'Phone app conversation (Chinese interface) showing the v2.4.0 release notes the model wrote' }
      ]
    },
    taskSuggestions: [
      { label: 'Build a new page', prompt: 'Give this project a better homepage. Get to know its existing style, build the page, check it on mobile, and show me what changed.', category: 'code' },
      { label: 'Work across apps', prompt: 'In Notes, create a note called “This week” with three items: read, go for a walk, and tidy up my project. Only change this new note.', category: 'apps' },
      { label: 'Review my changes', prompt: 'Review the uncommitted changes in this project for functional issues. Include the file, reasoning, and a suggested fix for each finding. Do not edit files yet.', category: 'review' }
    ],
    features: [
      {
        id: 'teams',
        tab: 'Agent Teams',
        title: 'One goal, one team.',
        body: 'Hand a large goal to a team lead. It splits the work and assigns teammates who run in parallel, with dependencies, progress, and every message between them on one board you can replay afterwards.',
        route: '/en/internals/agent',
        alt: 'Agent Teams run report (Chinese interface): the lead, four teammates working in parallel, and the shared task list by dependency'
      },
      {
        id: 'computer-use',
        tab: 'Computer Use',
        title: 'It has its own cursor.',
        body: 'With Computer Use on, the agent works in other apps through its own virtual cursor while your mouse and keyboard stay yours. This is native on macOS 14.4 and later; Windows uses a compatibility executor that moves the physical mouse.',
        route: '/en/desktop/computer-use',
        alt: 'Computer Use settings (Chinese interface): enabled, with Accessibility and Screen Recording granted'
      },
      {
        id: 'models',
        tab: 'Models',
        title: 'Any model you want.',
        body: 'Sign in with an official Claude, ChatGPT, or Grok account, pick a preset for DeepSeek, Kimi, GLM, and other APIs, or connect Ollama and LM Studio on your own machine. Full agent workflows need a model that supports tool calling.',
        route: '/en/start/models',
        alt: 'Composer model menu (Chinese interface): DeepSeek, Kimi, Zhipu GLM, and other providers grouped by source'
      },
      {
        id: 'workbench',
        tab: 'Workbench',
        title: 'Many tasks, one window.',
        body: 'Run several sessions at once, preview pages in the built-in browser, and review changes file by file with line comments, all in one desktop app.',
        route: '/en/desktop/workspace',
        alt: 'Desktop workbench (Chinese interface): sessions, the finished conversation with five changed files, and the new changelog page in the built-in browser'
      },
      {
        id: 'skills',
        tab: 'Skills',
        title: 'Install a skill, use it now.',
        body: 'Browse curated skills from ClawHub and SkillHub with their source and security scan status in plain view, then install in one click. Skills come from community sources, so look over the files before installing.',
        route: '/en/desktop/skills',
        alt: 'Skills Market (Chinese interface): 398 curated skills with source, safety, and category filters'
      }
    ],
    workflowSteps: [
      { title: 'Make room on your desktop', body: 'Download the app and open a project.', route: '/en/start/install' },
      { title: 'Bring a model you know', body: 'Choose an official account, an API, or a local model.', route: '/en/start/models' },
      { title: 'Hand over one small task', body: 'Set the goal, scope, and permission mode.', route: '/en/start/first-session' },
      { title: 'See how it turned out', body: 'Review the result, leave feedback, and choose what comes next.', route: '/en/desktop/workspace' }
    ],
    faqs: [
      { question: 'Is cc-haha free?', answer: 'cc-haha is free and open source. Model services are separate: subscriptions and API usage are billed by the provider you choose. You can also connect to a model running locally through LM Studio or Ollama.' },
      { question: 'Will it work on my devices?', answer: 'Desktop packages are available for macOS, Windows, and Linux, with supported Intel / AMD and ARM builds. Choose the right package in the installation guide. The phone app runs on Android and iPhone; on iPhone it is currently a public TestFlight beta. Computer Use has separate platform requirements, described below.' },
      { question: 'How do I connect my phone?', answer: 'On Android, download the APK whose name starts with cc-haha-mobile from GitHub Releases. On iPhone, install TestFlight and open the public beta link. Then scan the QR code under Phone connection in the desktop app: connect directly on the same Wi-Fi, or through Cloudflare when you are away. The phone app needs desktop v0.7.6 or later, and tasks always run on your computer.' },
      { question: 'Can I use a model I already have?', answer: 'Yes. Sign in with an official Claude, ChatGPT, or Grok account, configure a third-party API, or connect a local model. Available models depend on your account and provider. Agent workflows also require a model that supports tool calling.' },
      { question: 'Will Computer Use take over my mouse?', answer: 'On macOS 14.4 and later, the native runtime uses an independent virtual cursor and leaves your physical mouse and keyboard free, although some actions may change app focus. The Windows compatibility executor moves the physical mouse. Linux does not currently have an executor. Enabling the feature requires in-app consent and the relevant system permissions.' },
      { question: 'Can I control what AI changes?', answer: 'Choose a permission mode. The default Ask mode requests approval for file writes and commands that require authorization; other modes include planning only. Review edits and leave feedback in the workspace. Computer Use is enabled separately: once confirmed, it can operate all supported apps, so define the scope in your task as well.' }
    ],
    closing: {
      title: 'What would you like to do next?',
      body: 'Start with one small task. Make a little more room for yourself today.'
    }
  }
}
