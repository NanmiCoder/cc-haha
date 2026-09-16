import { forwardRef, type MutableRefObject } from 'react'
import {
  Bot,
  Bug,
  CircleDollarSign,
  CircleGauge,
  Command as CommandIcon,
  Eraser,
  GitCommitHorizontal,
  GitPullRequest,
  HelpCircle,
  LogIn,
  LogOut,
  Package,
  PanelTop,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Terminal,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from '@/i18n'
import type { SlashCommandGroups } from './composerUtils'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import { safeMentionIcon } from '@/lib/composerMentions'
import { publicAssetPath } from '@/lib/publicAsset'
import { referenceFallbackIcon, skillSourceLabelKey } from './referencePresentation'

const SYSTEM_SLASH_COMMAND_ICONS: Record<string, LucideIcon> = {
  agent: Bot,
  mcp: Wrench,
  skills: Package,
  help: HelpCircle,
  status: CircleGauge,
  cost: CircleDollarSign,
  context: PanelTop,
  plugin: Package,
  memory: Sparkles,
  doctor: Wrench,
  compact: Zap,
  clear: Eraser,
  goal: Target,
  review: ShieldCheck,
  commit: GitCommitHorizontal,
  pr: GitPullRequest,
  bug: Bug,
  config: Settings,
  login: LogIn,
  logout: LogOut,
  model: Bot,
  permissions: ShieldCheck,
  'terminal-setup': Terminal,
  vim: CommandIcon,
}

function getSystemSlashCommandIcon(commandName: string): LucideIcon {
  const rootCommand = commandName.trim().split(/\s+/, 1)[0] ?? ''
  return SYSTEM_SLASH_COMMAND_ICONS[rootCommand] ?? CommandIcon
}

export function getSlashCommandOptionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`
}

type SlashCommandMenuProps = {
  id: string
  groups: SlashCommandGroups
  selectedIndex: number
  itemRefs: MutableRefObject<(HTMLElement | null)[]>
  onSelect: (commandName: string) => void
  onHighlight: (index: number) => void
  showKeyboardHints: boolean
  references?: ComposerReferenceCandidate[]
}

export const SlashCommandMenu = forwardRef<HTMLDivElement, SlashCommandMenuProps>(
  function SlashCommandMenu(
    {
      id,
      groups,
      selectedIndex,
      itemRefs,
      onSelect,
      onHighlight,
      showKeyboardHints,
      references = [],
    },
    ref,
  ) {
    const t = useTranslation()

    const renderSystemCommand = (command: SlashCommandGroups['system'][number], index: number) => {
      const Icon = getSystemSlashCommandIcon(command.name)
      return (
        <div
          id={getSlashCommandOptionId(id, index)}
          key={command.name}
          role="option"
          tabIndex={-1}
          aria-selected={index === selectedIndex}
          ref={(element) => { itemRefs.current[index] = element }}
          onClick={() => onSelect(command.name)}
          onMouseEnter={() => onHighlight(index)}
          className={`flex w-full cursor-default items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left transition-colors ${
            index === selectedIndex
              ? 'bg-[var(--color-surface-hover)]'
              : 'hover:bg-[var(--color-surface-hover)]'
          }`}
        >
          <Icon
            aria-hidden="true"
            className="h-5 w-5 shrink-0 text-[var(--color-text-secondary)]"
            strokeWidth={1.8}
          />
          <span className="flex min-w-0 max-w-[52%] shrink-0 items-baseline gap-1.5">
            <span className="shrink-0 text-sm font-medium text-[var(--color-text-primary)]">
              {command.name}
            </span>
            {command.argumentHint ? (
              <span className="min-w-0 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
                {command.argumentHint}
              </span>
            ) : null}
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-xs text-[var(--color-text-tertiary)]">
            {command.description}
          </span>
        </div>
      )
    }

    return (
      <div
        ref={ref}
        onMouseDown={event => event.preventDefault()}
        className="absolute bottom-full left-0 right-0 z-[var(--z-dropdown)] mb-2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-overlay)]"
      >
        <div
          id={id}
          role="listbox"
          aria-label={t('chat.slashCommands')}
          className="max-h-[420px] overflow-y-auto p-1.5"
        >
          {groups.system.map(renderSystemCommand)}

          {([
            { kind: 'plugin' as const, items: groups.plugins ?? [], label: t('chat.referencePlugins'), offset: groups.system.length },
            { kind: 'skill' as const, items: groups.skills, label: t('sidebar.skills'), offset: groups.system.length + (groups.plugins?.length ?? 0) },
          ]).map(group => group.items.length > 0 ? (
            <div key={group.kind} role="group" aria-label={group.label}>
              <div className="px-3 pb-1 pt-2 text-xs font-medium text-[var(--color-text-tertiary)]">{group.label}</div>
              {group.items.map((command, position) => {
                const index = group.offset + position
                const candidate = references.find(item => item.kind === group.kind && (item.name === command.name || item.id === command.name))
                const icon = safeMentionIcon(candidate?.icon)
                const Icon = referenceFallbackIcon(group.kind)
                const sourceLabel = skillSourceLabelKey(command.source)
                return <div
                  id={getSlashCommandOptionId(id, index)} key={command.name} role="option" tabIndex={-1}
                  aria-selected={index === selectedIndex} aria-labelledby={`${id}-label-${index}`} aria-describedby={`${id}-description-${index}`}
                  ref={element => { itemRefs.current[index] = element }}
                  onClick={() => onSelect(command.name)} onMouseEnter={() => onHighlight(index)}
                  className={`flex w-full cursor-default items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${index === selectedIndex ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'}`}>
                  {icon ? <img src={publicAssetPath(icon)} alt="" className="h-5 w-5 shrink-0 object-contain" /> : <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--color-text-secondary)]" strokeWidth={1.8} />}
                  <span id={`${id}-label-${index}`} className="min-w-0 max-w-[45%] shrink-0 truncate text-sm font-medium text-[var(--color-text-primary)]">{candidate?.displayName || command.name}</span>
                  <span id={`${id}-description-${index}`} className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-tertiary)]">{command.description}</span>
                  {sourceLabel ? <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">{t(sourceLabel)}</span> : null}
                </div>
              })}
            </div>
          ) : null)}
        </div>
        {showKeyboardHints ? (
          <div className="flex items-center gap-1.5 border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-tertiary)]">
            <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1.5 py-0.5 font-mono text-[10px]">Up/Down</kbd>
            <span>{t('chat.navigate')}</span>
            <kbd className="ml-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1.5 py-0.5 font-mono text-[10px]">Enter</kbd>
            <span>{t('chat.select')}</span>
            <kbd className="ml-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd>
            <span>{t('chat.dismiss')}</span>
          </div>
        ) : null}
      </div>
    )
  },
)
