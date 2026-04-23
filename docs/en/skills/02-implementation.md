# Claude Code Skills System -- Implementation Details

> A deep dive into how Skills are discovered, loaded, injected, executed, and managed.

<p align="center">
<a href="#1-overall-architecture">Architecture</a> · <a href="#2-skill-discovery-and-loading">Discovery & Loading</a> · <a href="#3-frontmatter-parsing">Frontmatter Parsing</a> · <a href="#4-skill-injection-into-conversations">Injection</a> · <a href="#5-skilltool-execution-engine">Execution Engine</a> · <a href="#6-fork-sub-agent-execution">Fork Execution</a> · <a href="#7-conditional-activation-and-dynamic-discovery">Conditional Activation</a> · <a href="#8-hook-integration">Hook Integration</a> · <a href="#9-permission-system">Permission System</a> · <a href="#10-complete-lifecycle">Complete Lifecycle</a> · <a href="#11-source-code-index">Source Index</a>
</p>

![Skills Architecture Overview](./images/04-skills-architecture.png)

---

## 1. Overall Architecture

The Skills system consists of 5 core modules working together:

```
┌─────────────────────────────────────────────────────┐
│                   Skills System                      │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  Discovery   │  │   Prompt     │  │  SkillTool │ │
│  │  & Loading   │→│  Injection   │→│  Execution  │ │
│  └─────────────┘  └──────────────┘  └────────────┘ │
│         ↑                                    ↓      │
│  ┌─────────────┐                     ┌────────────┐ │
│  │  Activation  │                     │  Context   │ │
│  │  Conditional │←────────────────────│  Modifier  │ │
│  └─────────────┘                     └────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Module Responsibilities

| Module | Core File | Responsibility |
|--------|-----------|----------------|
| Discovery | `loadSkillsDir.ts` | Discover and load Skills from 6 sources |
| Prompt | `prompt.ts` + `attachments.ts` | Inject Skill listing into system-reminder |
| SkillTool | `SkillTool.ts` | Validation, permission checks, Skill execution |
| Activation | `loadSkillsDir.ts` (second half) | Conditional activation and dynamic discovery |
| Context | `forkedAgent.ts` | Context preparation and modification |

---

## 2. Skill Discovery and Loading

### Loading Entry Point

Skills loading begins with the `getSkills()` function in `commands.ts`:

```typescript
// src/commands.ts:351-396
async function getSkills(cwd: string) {
  const [skillDirCommands, pluginSkills] = await Promise.all([
    getSkillDirCommands(cwd),    // Directory Skills (managed/user/project)
    getPluginSkills(),            // Plugin Skills
  ])
  const bundledSkills = getBundledSkills()          // Built-in Skills
  const builtinPluginSkills = getBuiltinPluginSkillCommands()  // Built-in plugin Skills
  return { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills }
}
```

### Aggregation and Ordering

All Skills from all sources are aggregated in `loadAllCommands()`, ordered by priority:

```typescript
// src/commands.ts:447-467
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  return [
    ...bundledSkills,        // 1. Built-in Skills (highest priority)
    ...builtinPluginSkills,  // 2. Built-in plugin Skills
    ...skillDirCommands,     // 3. Directory Skills (managed → user → project)
    ...workflowCommands,     // 4. Workflow commands
    ...pluginCommands,       // 5. Plugin commands
    ...pluginSkills,         // 6. Plugin Skills
    ...COMMANDS(),           // 7. Built-in commands (lowest priority)
  ]
})
```

**Key feature:** Uses `memoize` for caching to avoid redundant disk I/O.

### Directory Skill Loading Flow

![Skill Loading Flow](./images/05-skill-loading.png)

`getSkillDirCommands()` is the core loading function for directory Skills:

```
getSkillDirCommands(cwd)
├─ Determine loading paths
│  ├─ managed: ${MANAGED_PATH}/.claude/skills/
│  ├─ user:    ~/.claude/skills/
│  ├─ project: .claude/skills/ (traverse upward to HOME)
│  └─ additional: paths specified via --add-dir
│
├─ Parallel loading (Promise.all)
│  ├─ loadSkillsFromSkillsDir(managedDir, 'policySettings')
│  ├─ loadSkillsFromSkillsDir(userDir, 'userSettings')
│  ├─ loadSkillsFromSkillsDir(projectDirs, 'projectSettings')
│  ├─ loadSkillsFromSkillsDir(additionalDirs, 'projectSettings')
│  └─ loadSkillsFromCommandsDir(cwd)  ← Legacy /commands/ format compatibility
│
├─ Deduplication (by realpath)
│  └─ getFileIdentity(filePath) → realpath resolves symlinks
│     └─ seenFileIds Map, first occurrence wins
│
└─ Separate conditional Skills
   ├─ No paths → unconditionalSkills (immediately available)
   └─ Has paths → conditionalSkills Map (awaiting activation)
```

### Deduplication Mechanism

```typescript
// src/skills/loadSkillsDir.ts:725-763
const fileIds = await Promise.all(
  allSkillsWithPaths.map(({ skill, filePath }) =>
    skill.type === 'prompt'
      ? getFileIdentity(filePath)  // realpath() resolves symlinks
      : Promise.resolve(null),
  ),
)

const seenFileIds = new Map<string, SettingSource>()
for (const entry of allSkillsWithPaths) {
  const fileId = fileIds[i]
  const existingSource = seenFileIds.get(fileId)
  if (existingSource !== undefined) continue  // Skip duplicates
  seenFileIds.set(fileId, skill.source)
  deduplicatedSkills.push(skill)
}
```

### Bundled Skill Registration

Built-in Skills use an entirely different registration path:

```typescript
// src/skills/bundledSkills.ts:53-100
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  // If files are present, create extraction directory and lazy extraction logic
  if (files && Object.keys(files).length > 0) {
    skillRoot = getBundledSkillExtractDir(definition.name)
    // Extract files to disk on first invocation
    getPromptForCommand = async (args, ctx) => {
      extractionPromise ??= extractBundledSkillFiles(name, files)
      const extractedDir = await extractionPromise
      const blocks = await inner(args, ctx)
      return prependBaseDir(blocks, extractedDir)
    }
  }

  const command: Command = {
    type: 'prompt',
    source: 'bundled',
    loadedFrom: 'bundled',
    // ...other fields
  }
  bundledSkills.push(command)
}
```

**File extraction:** Bundled Skills can include a `files: Record<string, string>` field. On first invocation, these files are extracted to disk (`getBundledSkillExtractDir()`), allowing the model to access them via Read/Grep.

### Startup Registration

```typescript
// src/skills/bundled/index.ts:13-58
export function initBundledSkills(): void {
  require('./verify.js').registerVerifySkill()
  require('./debug.js').registerDebugSkill()
  require('./remember.js').registerRememberSkill()
  // ...
  if (feature('AGENT_TRIGGERS')) {
    require('./loop.js').registerLoopSkill()     // Feature-gated
  }
  if (feature('KAIROS')) {
    require('./dream.js').registerDreamSkill()    // Feature-gated
  }
}
```

### Plugin Skill Loading

```
Plugin System
├─ loadAllPluginsCacheOnly()
│  └─ Get all enabled plugins
│
├─ For each plugin:
│  ├─ Read manifest.skillsPath → default Skills directory
│  ├─ Read manifest.skillsPaths[] → additional Skills directories
│  └─ loadSkillsFromDirectory() to load SKILL.md
│
├─ Namespacing:
│  └─ {pluginName}:{namespace}:{skillName}
│     e.g.: superpowers:code-reviewer
│
└─ Variable substitution:
   ├─ ${CLAUDE_PLUGIN_ROOT} → plugin root directory
   ├─ ${CLAUDE_PLUGIN_DATA} → plugin data directory
   ├─ ${CLAUDE_SKILL_DIR}   → skill directory
   └─ ${user_config.X}      → user configuration values
```

### MCP Skill Loading

```typescript
// src/services/mcp/client.ts:2030-2102
// MCP prompts are converted to Command objects
async function fetchCommandsForClient(client) {
  const prompts = await client.listPrompts()
  return prompts.map(prompt => ({
    type: 'prompt',
    name: `mcp__${normalizeNameForMCP(serverName)}__${prompt.name}`,
    source: 'mcp',
    loadedFrom: 'mcp',
    // getPromptForCommand calls the MCP server to fetch content
  }))
}
```

**Feature gate:** `feature('MCP_SKILLS')` controls whether MCP Skills are available.

---

## 3. Frontmatter Parsing

### Parsing Flow

```
SKILL.md file
    ↓
parseFrontmatter()              ← frontmatterParser.ts
    ├─ Separate YAML frontmatter from Markdown content
    ├─ quoteProblematicValues()  ← Handle special characters (glob patterns, etc.)
    └─ parseYaml()               ← Parse YAML
    ↓
parseSkillFrontmatterFields()   ← loadSkillsDir.ts:185-265
    ├─ description extraction priority:
    │  1. frontmatter.description field
    │  2. First # heading in Markdown
    │  3. Skill name as fallback
    ├─ parseUserSpecifiedModel()     ← Model alias resolution
    ├─ parseEffortValue()            ← Effort level parsing
    ├─ parseHooksFromFrontmatter()   ← Hook configuration validation
    ├─ parseBooleanFrontmatter()     ← Boolean field parsing
    └─ parseSlashCommandToolsFromFrontmatter() ← Tool list parsing
    ↓
createSkillCommand()            ← loadSkillsDir.ts:270-401
    └─ Generate Command object (with getPromptForCommand closure)
```

### FrontmatterData Type Definition

```typescript
// src/utils/frontmatterParser.ts:10-59
export type FrontmatterData = {
  'allowed-tools'?: string | string[] | null
  description?: string | null
  'argument-hint'?: string | null
  when_to_use?: string | null
  version?: string | null
  model?: string | null          // haiku, sonnet, opus, inherit
  'user-invocable'?: string | null
  'disable-model-invocation'?: string | null
  hooks?: HooksSettings | null
  effort?: string | null         // low, medium, high, max, or numeric
  context?: 'inline' | 'fork' | null
  agent?: string | null
  paths?: string | string[] | null
  shell?: string | null          // bash, powershell
  [key: string]: unknown
}
```

### The getPromptForCommand Closure

Each Command object contains a `getPromptForCommand` closure that executes upon invocation:

```typescript
// src/skills/loadSkillsDir.ts:344-399
async getPromptForCommand(args, toolUseContext) {
  // 1. Add base directory header
  let finalContent = baseDir
    ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
    : markdownContent

  // 2. Argument substitution
  finalContent = substituteArguments(finalContent, args, true, argumentNames)

  // 3. Skill directory variable substitution
  if (baseDir) {
    finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
  }

  // 4. Session ID substitution
  finalContent = finalContent.replace(/\$\{CLAUDE_SESSION_ID\}/g, getSessionId())

  // 5. Execute inline shell commands (skipped for MCP Skills — security restriction)
  if (loadedFrom !== 'mcp') {
    finalContent = await executeShellCommandsInPrompt(finalContent, context)
  }

  return [{ type: 'text', text: finalContent }]
}
```

---

## 4. Skill Injection into Conversations

### Injection Flow

![Skill Listing Injection](./images/06-skill-injection.png)

Skills are injected into conversations via `system-reminder` messages:

```
Start of each conversation turn
    ↓
getSkillListingAttachments()          ← attachments.ts:2600-2747
    ├─ getSkillToolCommands(cwd)      ← Get all model-invocable Skills
    ├─ getMcpSkillCommands()          ← Get MCP Skills
    ├─ sentSkillNames Map tracking    ← Avoid duplicate sends (per-agent)
    └─ formatCommandsWithinBudget()   ← Truncate to context budget
    ↓
Returns Attachment:
  { type: 'skill_listing', content, skillCount, isInitial }
    ↓
normalizeAttachmentForAPI()           ← messages.ts:3732-3737
    ↓
Wrapped as <system-reminder> user message:
  "The following skills are available for use with the Skill tool:
   - commit: Create a git commit...
   - review-pr: Review a pull request...
   - superpowers:code-reviewer: Expert code review..."
```

### Context Budget Control

```typescript
// src/tools/SkillTool/prompt.ts:21-29
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01  // 1% of context window
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000           // 200k × 4 × 1% fallback
export const MAX_LISTING_DESC_CHARS = 250          // Max characters per description
```

**Truncation strategy:**

```
formatCommandsWithinBudget(commands, contextWindowTokens)
    ├─ Calculate total budget = contextWindowTokens × 4 × 1%
    ├─ Try full descriptions
    │  └─ Total chars ≤ budget → output all
    │
    ├─ Partition: Bundled (never truncated) + rest
    │  ├─ Bundled Skills always retain full descriptions
    │  └─ Remaining Skills split the leftover budget evenly
    │
    ├─ Truncate descriptions → maxDescLen characters
    │  └─ maxDescLen < 20 → extreme case: non-Bundled show name only
    │
    └─ Output format: "- skill-name: description..."
```

### SkillTool Prompt

The tool prompt definition seen by the model:

```typescript
// src/tools/SkillTool/prompt.ts:173-196
export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  return `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - skill: "pdf"
  - skill: "commit", args: "-m 'Fix bug'"

Important:
- Available skills are listed in system-reminder messages
- When a skill matches, invoke BEFORE generating any other response
- NEVER mention a skill without calling this tool
- Do not invoke a skill that is already running
`
})
```

---

## 5. SkillTool Execution Engine

### Tool Definition

```typescript
// src/tools/SkillTool/SkillTool.ts:331-340
export const SkillTool = buildTool({
  name: 'Skill',
  inputSchema: z.object({
    skill: z.string(),    // Skill name
    args: z.string().optional(),  // Optional arguments
  }),
  outputSchema: z.union([inlineOutputSchema, forkedOutputSchema]),
})
```

### Execution Flow

![SkillTool Execution Flow](./images/07-skill-execution.png)

```
SkillTool.call({ skill, args })
    │
    ├─ 1. Normalize input
    │  └─ Strip leading /, trim whitespace
    │
    ├─ 2. Remote Skill check (experimental)
    │  └─ _canonical_<slug> prefix → executeRemoteSkill()
    │
    ├─ 3. Find Command object
    │  └─ getAllCommands(context) → findCommand(name, commands)
    │
    ├─ 4. Record usage frequency
    │  └─ recordSkillUsage(commandName) → influences sorting recommendations
    │
    ├─ 5. Determine execution path
    │  ├─ command.context === 'fork'
    │  │  └─ → executeForkedSkill()  [see Section 6]
    │  │
    │  └─ Default: inline
    │     ├─ processPromptSlashCommand()
    │     │  └─ getMessagesForPromptSlashCommand()
    │     │     ├─ command.getPromptForCommand(args, context)
    │     │     ├─ registerSkillHooks()      ← Register hooks
    │     │     ├─ addInvokedSkill()         ← Record (restored after compression)
    │     │     ├─ formatCommandLoadingMetadata()
    │     │     │  └─ <command-name>/skillName</command-name>
    │     │     └─ Extract attachments → create messages
    │     │
    │     ├─ Extract metadata: allowedTools, model, effort
    │     ├─ tagMessagesWithToolUseID() ← Associate with tool_use
    │     └─ Return { newMessages, contextModifier }
    │
    └─ 6. contextModifier() closure
       ├─ Update allowedTools
       │  └─ appState.toolPermissionContext.alwaysAllowRules.command
       ├─ Update model
       │  └─ resolveSkillModelOverride() preserves [1m] suffix
       └─ Update effort
          └─ appState.effortValue
```

### Validation Logic

```typescript
// src/tools/SkillTool/SkillTool.ts:354-430
async validateInput({ skill }, context) {
  // 1. Format check — non-empty
  // 2. Normalize — strip leading /
  // 3. Remote Skill check — _canonical_ prefix
  // 4. Lookup — findCommand() within getAllCommands()
  // 5. Disabled check — disableModelInvocation
  // 6. Type check — must be 'prompt' type
}
```

**Error code definitions:**

| errorCode | Meaning |
|-----------|---------|
| 1 | Invalid format (empty skill name) |
| 2 | Unknown skill |
| 4 | Model invocation disabled |
| 5 | Not a prompt type |
| 6 | Remote skill not found |

### getAllCommands -- MCP Skill Merging

```typescript
// src/tools/SkillTool/SkillTool.ts:81-94
async function getAllCommands(context: ToolUseContext): Promise<Command[]> {
  // Get MCP Skills from AppState (loadedFrom === 'mcp')
  const mcpSkills = context.getAppState()
    .mcp.commands.filter(
      cmd => cmd.type === 'prompt' && cmd.loadedFrom === 'mcp',
    )
  if (mcpSkills.length === 0) return getCommands(getProjectRoot())
  const localCommands = await getCommands(getProjectRoot())
  return uniqBy([...localCommands, ...mcpSkills], 'name')
}
```

---

## 6. Fork Sub-Agent Execution

### Execution Flow

```
executeForkedSkill(command, commandName, args, context, ...)
    │
    ├─ 1. Create sub-agent ID
    │  └─ agentId = createAgentId()
    │
    ├─ 2. Telemetry recording
    │  └─ logEvent('tengu_skill_tool_invocation', { execution_context: 'fork' })
    │
    ├─ 3. Prepare fork context
    │  └─ prepareForkedCommandContext(command, args, context)
    │     ├─ command.getPromptForCommand(args, context)  ← Get skill content
    │     ├─ parseToolListFromCLI(allowedTools)           ← Parse tool whitelist
    │     ├─ createGetAppStateWithAllowedTools()          ← Modify AppState
    │     ├─ Select agent: command.agent ?? 'general-purpose'
    │     └─ promptMessages = [createUserMessage(skillContent)]
    │
    ├─ 4. Merge effort
    │  └─ command.effort → inject into agentDefinition
    │
    ├─ 5. Run sub-agent
    │  └─ for await (message of runAgent({
    │       agentDefinition,
    │       promptMessages,
    │       toolUseContext: { ...context, getAppState: modifiedGetAppState },
    │       model: command.model,
    │       override: { agentId },
    │     }))
    │     └─ Collect messages + report progress (onProgress)
    │
    ├─ 6. Extract results
    │  └─ extractResultText(agentMessages)
    │     └─ Get text from the last assistant message
    │
    └─ 7. Cleanup
       └─ clearInvokedSkillsForAgent(agentId)
```

### prepareForkedCommandContext

```typescript
// src/utils/forkedAgent.ts:191-232
export async function prepareForkedCommandContext(
  command: PromptCommand,
  args: string,
  context: ToolUseContext,
): Promise<PreparedForkedContext> {
  // Get skill content (with argument substitution and shell execution)
  const skillPrompt = await command.getPromptForCommand(args, context)
  const skillContent = skillPrompt.map(b => b.type === 'text' ? b.text : '').join('\n')

  // Build tool whitelist
  const allowedTools = parseToolListFromCLI(command.allowedTools ?? [])
  const modifiedGetAppState = createGetAppStateWithAllowedTools(
    context.getAppState, allowedTools,
  )

  // Select agent type
  const agentTypeName = command.agent ?? 'general-purpose'
  const baseAgent = agents.find(a => a.agentType === agentTypeName)

  // Build prompt messages
  const promptMessages = [createUserMessage({ content: skillContent })]

  return { skillContent, modifiedGetAppState, baseAgent, promptMessages }
}
```

### Inline vs Fork Return Differences

**Inline return:**
```typescript
{
  data: {
    success: true,
    commandName: 'commit',
    allowedTools: ['Bash', 'Read'],
    model: 'sonnet',
    status: 'inline',
  },
  newMessages: [...],        // Injected into conversation
  contextModifier: (ctx) => { ... },  // Modifies context
}
```

**Fork return:**
```typescript
{
  data: {
    success: true,
    commandName: 'verify',
    status: 'forked',
    agentId: 'agent_abc123',
    result: 'Verification passed, all tests have run...',
  },
  // No newMessages — result is embedded in the tool_result block
}
```

---

## 7. Conditional Activation and Dynamic Discovery

### Conditional Skills

![Conditional Activation Mechanism](./images/08-conditional-activation.png)

Skills with `paths` frontmatter are not immediately exposed to the model:

```
At startup
├─ Load all Skills
├─ Those with paths → conditionalSkills Map
└─ Those without paths → immediately available

At runtime (triggered by file operations)
├─ activateConditionalSkillsForPaths(filePaths, cwd)
│  ├─ Iterate over conditionalSkills Map
│  ├─ Match paths patterns using the ignore library
│  │  └─ filePath converted to cwd-relative path before matching
│  ├─ On match:
│  │  ├─ Move to dynamicSkills Map
│  │  ├─ Remove from conditionalSkills
│  │  ├─ Add to activatedConditionalSkillNames Set
│  │  └─ Log telemetry: tengu_dynamic_skills_changed
│  └─ Once activated, remains active for the session
└─ Notify cache invalidation → skillsLoaded.emit()
```

### Dynamic Discovery

When operating on files in deeply nested directories, the system automatically discovers new Skills:

```typescript
// src/skills/loadSkillsDir.ts:861-915
export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  for (const filePath of filePaths) {
    let currentDir = dirname(filePath)
    // Traverse upward from the file's directory to cwd (excluding cwd itself)
    while (currentDir.startsWith(resolvedCwd + pathSep)) {
      const skillDir = join(currentDir, '.claude', 'skills')
      if (!dynamicSkillDirs.has(skillDir)) {
        dynamicSkillDirs.add(skillDir)
        await fs.stat(skillDir)  // Check if it exists
        // Check if ignored by .gitignore
        if (await isPathGitignored(currentDir, resolvedCwd)) continue
        newDirs.push(skillDir)
      }
      currentDir = dirname(currentDir)
    }
  }
  // Sort by depth (deepest first), ensuring nearest Skills have higher priority
  return newDirs.sort((a, b) => b.split(pathSep).length - a.split(pathSep).length)
}
```

### Cache Invalidation Chain

```
Dynamic Skill change
    ↓
skillsLoaded.emit()
    ↓
clearCommandMemoizationCaches()
    ├─ loadAllCommands.cache.clear()
    ├─ getSkillToolCommands.cache.clear()
    ├─ getSlashCommandToolSkills.cache.clear()
    └─ clearSkillIndexCache()
    ↓
Next conversation turn loads the updated Skill list
```

---

## 8. Hook Integration

### Hook Registration

Skills can declare hooks via frontmatter, which are automatically registered as session-level hooks upon invocation:

```typescript
// src/utils/hooks/registerSkillHooks.ts:20-64
export function registerSkillHooks(
  setAppState, sessionId, hooks, skillName, skillRoot?,
): void {
  for (const eventName of HOOK_EVENTS) {
    const matchers = hooks[eventName]
    if (!matchers) continue
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        // once: true → automatically removed after one execution
        const onHookSuccess = hook.once
          ? () => removeSessionHook(setAppState, sessionId, eventName, hook)
          : undefined

        addSessionHook(
          setAppState, sessionId, eventName,
          matcher.matcher || '',
          hook, onHookSuccess, skillRoot,
        )
      }
    }
  }
}
```

### Hook Lifecycle

```
Skill invocation
    ↓
processPromptSlashCommand()
    ├─ Check command.hooks
    └─ registerSkillHooks(setAppState, sessionId, hooks, skillName, skillRoot)
         ├─ Iterate over HOOK_EVENTS (PreToolUse, PostToolUse, Stop, ...)
         ├─ Register addSessionHook() for each matcher
         ├─ skillRoot → CLAUDE_PLUGIN_ROOT environment variable
         └─ once: true → removeSessionHook() after first execution
    ↓
During session
    ├─ Tool calls trigger PreToolUse/PostToolUse
    ├─ Matcher matches → execute hook command
    └─ Hooks with once: true are automatically removed after first execution
```

---

## 9. Permission System

### Check Flow

```
checkPermissions({ skill, args }, context)
    │
    ├─ 1. Deny rule check (highest priority)
    │  └─ getRuleByContentsForTool(context, SkillTool, 'deny')
    │     ├─ Exact match: "commit" === commandName
    │     └─ Prefix match: "review:*" → commandName.startsWith("review")
    │
    ├─ 2. Remote Skill auto-allow
    │  └─ _canonical_<slug> → auto-allow (Ant-specific experimental)
    │
    ├─ 3. Allow rule check
    │  └─ getRuleByContentsForTool(context, SkillTool, 'allow')
    │
    ├─ 4. Safe property auto-allow
    │  └─ skillHasOnlySafeProperties(command)
    │     └─ SAFE_SKILL_PROPERTIES whitelist check
    │
    └─ 5. Default: ask user
       └─ Provide suggestions: exact allow + prefix allow
```

### Safe Property Whitelist

If a Skill contains only the following properties (no hooks, no allowedTools, no fork), it is automatically allowed:

```
SAFE_SKILL_PROPERTIES = {
  type, name, description, contentLength, source,
  loadedFrom, progressMessage, userInvocable,
  disableModelInvocation, hasUserSpecifiedDescription,
  getPromptForCommand, userFacingName, ...
}
```

**Core principle:** Newly added frontmatter fields require permission by default, unless explicitly added to the whitelist.

---

## 10. Complete Lifecycle

### Data Flow Overview

![Complete Lifecycle](./images/09-skill-lifecycle.png)

```
Phase 1: Discovery and Registration
──────────────────────────────────
CLI startup
    ├─ initBundledSkills()        → bundledSkills[]
    ├─ getPluginSkills()          → pluginSkills[]
    ├─ getSkillDirCommands(cwd)   → skillDirCommands[]
    │  └─ Conditional Skills → conditionalSkills Map
    └─ loadAllCommands()          → aggregate & memoize

Phase 2: Injection into Conversation
────────────────────────────────────
Each conversation turn
    ├─ getSkillListingAttachments()
    │  ├─ getSkillToolCommands()  → filter model-invocable Skills
    │  ├─ getMcpSkillCommands()   → MCP Skills
    │  └─ formatCommandsWithinBudget()  → truncate to budget
    └─ Wrap as <system-reminder> message and inject

Phase 3: Invocation and Execution
─────────────────────────────────
Model/user trigger
    ├─ SkillTool.validateInput()  → validation
    ├─ SkillTool.checkPermissions()  → permissions
    └─ SkillTool.call()
       ├─ Inline → processPromptSlashCommand()
       │  ├─ getPromptForCommand()  → content expansion
       │  ├─ registerSkillHooks()   → hook registration
       │  ├─ addInvokedSkill()      → record (restored after compression)
       │  └─ contextModifier()      → update tools/model/effort
       └─ Fork → executeForkedSkill()
          ├─ prepareForkedCommandContext()
          ├─ runAgent()             → sub-agent execution
          └─ extractResultText()    → extract results

Phase 4: Runtime Discovery
─────────────────────────
File operation trigger
    ├─ discoverSkillDirsForPaths()   → new Skills directories
    ├─ addSkillDirectories()          → load & register
    ├─ activateConditionalSkillsForPaths()  → conditional activation
    └─ clearCommandMemoizationCaches()      → cache invalidation
```

### Skill Content Persistence

Inline Skill content is recorded to session state via `addInvokedSkill()`, ensuring it can be restored after context compression:

```
addInvokedSkill(name, path, content, agentId)
    ↓
Stored in session state
    ↓
On compression → buildPostCompactMessages()
    ↓
Restored scoped by agentId (prevents cross-agent leakage)
```

---

## 11. Source Code Index

### Core Files

| File | Responsibility |
|------|----------------|
| `src/tools/SkillTool/SkillTool.ts` | SkillTool definition, validation, permissions, execution |
| `src/tools/SkillTool/prompt.ts` | Tool prompt, Skill listing formatting, budget control |
| `src/skills/loadSkillsDir.ts` | Directory Skill discovery, loading, deduplication, conditional activation |
| `src/skills/bundledSkills.ts` | Built-in Skill registration system |
| `src/skills/bundled/index.ts` | Built-in Skills initialization entry point |
| `src/commands.ts` | Command aggregation, ordering, filtering, cache management |

### Type Definitions

| File | Key Types |
|------|-----------|
| `src/types/command.ts` | `PromptCommand`, `Command`, `LocalCommandResult` |
| `src/utils/frontmatterParser.ts` | `FrontmatterData`, `ParsedMarkdown` |
| `src/skills/bundledSkills.ts` | `BundledSkillDefinition` |

### Utility Modules

| File | Responsibility |
|------|----------------|
| `src/utils/forkedAgent.ts` | Fork context preparation, result extraction |
| `src/utils/hooks/registerSkillHooks.ts` | Skill hook registration |
| `src/utils/argumentSubstitution.ts` | Argument substitution ($ARGUMENTS, ${ARG1}) |
| `src/utils/promptShellExecution.ts` | Inline shell command execution |
| `src/utils/attachments.ts` | Skill listing attachment generation |
| `src/utils/messages.ts` | system-reminder wrapping |
| `src/utils/plugins/loadPluginCommands.ts` | Plugin Skill loading |
| `src/services/mcp/client.ts` | MCP Skill conversion |
| `src/skills/mcpSkillBuilders.ts` | MCP Skill builder registration |

### Key Constants

| Constant | Value | Location |
|----------|-------|----------|
| `SKILL_BUDGET_CONTEXT_PERCENT` | 0.01 | prompt.ts:21 |
| `DEFAULT_CHAR_BUDGET` | 8,000 | prompt.ts:23 |
| `MAX_LISTING_DESC_CHARS` | 250 | prompt.ts:29 |
| `SKILL_TOOL_NAME` | `'Skill'` | constants.ts |

### Telemetry Events

| Event | Description |
|-------|-------------|
| `tengu_skill_tool_invocation` | Skill invocation (includes execution_context, invocation_trigger) |
| `tengu_skill_tool_slash_prefix` | Model used the / prefix |
| `tengu_dynamic_skills_changed` | Dynamic Skills changed (conditional activation/directory discovery) |
| `tengu_skill_descriptions_truncated` | Skill descriptions were truncated |
