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

export const landingContent: LandingContent = {
  hero: {
    eyebrow: 'Free & open source · macOS · Windows · Linux · Android · iOS',
    headline: ['Claude Code on your desktop.', 'And in your '],
    accent: 'pocket.',
    description: ['Parallel sessions, Agent Teams, Computer Use, and any model you like.', 'Pair your phone to approve and start tasks away from your desk.'],
    desktopAlt: 'cc-haha desktop: a session that added a changelog page asks to run bun test && npm run build',
    phoneAlt: 'The same request in the cc-haha phone app, with Deny and Allow buttons',
    phoneLabel: 'Phone app:'
  },
  downloads: {
    desktop: 'Get the desktop app',
    android: 'Android APK',
    iphone: 'iPhone · TestFlight',
    androidLabel: 'Download the Android APK from GitHub Releases',
    iphoneLabel: 'Install the iPhone app from the public TestFlight beta',
    requirement: 'The phone app needs desktop v0.7.6 or later.'
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
    route: '/desktop/remote',
    screens: [
      { caption: 'Home: what finished and what needs you', alt: 'Phone app home: four tasks in the lumen project, three done and one waiting for approval' },
      { caption: 'Approve a command from your phone', alt: 'Phone app approval sheet for bun test && npm run build, with Deny and Allow' },
      { caption: 'Read the result where you are', alt: 'Phone app conversation showing the v2.4.0 release notes the model wrote' }
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
      route: '/internals/agent',
      alt: 'Agent Teams run report: the lead, four teammates working in parallel, and the shared task list by dependency'
    },
    {
      id: 'computer-use',
      tab: 'Computer Use',
      title: 'It has its own cursor.',
      body: 'With Computer Use on, the agent works in other apps through its own virtual cursor while your mouse and keyboard stay yours. This is native on macOS 14.4 and later; Windows uses a compatibility executor that moves the physical mouse.',
      route: '/desktop/computer-use',
      alt: 'Computer Use settings: enabled, with Accessibility and Screen Recording granted'
    },
    {
      id: 'models',
      tab: 'Models',
      title: 'Any model you want.',
      body: 'Sign in with an official Claude, ChatGPT, or Grok account, pick a preset for DeepSeek, Kimi, GLM, and other APIs, or connect Ollama and LM Studio on your own machine. Full agent workflows need a model that supports tool calling.',
      route: '/start/models',
      alt: 'Composer model menu: DeepSeek, Kimi, Zhipu GLM, and other providers grouped by source'
    },
    {
      id: 'workbench',
      tab: 'Workbench',
      title: 'Many tasks, one window.',
      body: 'Run several sessions at once, preview pages in the built-in browser, and review changes file by file with line comments, all in one desktop app.',
      route: '/desktop/workspace',
      alt: 'Desktop workbench: sessions, the finished conversation with five changed files, and the new changelog page in the built-in browser'
    },
    {
      id: 'skills',
      tab: 'Skills',
      title: 'Install a skill, use it now.',
      body: 'Browse curated skills from ClawHub and SkillHub with their source and security scan status in plain view, then install in one click. Skills come from community sources, so look over the files before installing.',
      route: '/desktop/skills',
      alt: 'Skills Market: 398 curated skills with source, safety, and category filters'
    }
  ],
  workflowSteps: [
    { title: 'Make room on your desktop', body: 'Download the app and open a project.', route: '/start/install' },
    { title: 'Bring a model you know', body: 'Choose an official account, an API, or a local model.', route: '/start/models' },
    { title: 'Hand over one small task', body: 'Set the goal, scope, and permission mode.', route: '/start/first-session' },
    { title: 'See how it turned out', body: 'Review the result, leave feedback, and choose what comes next.', route: '/desktop/workspace' }
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
