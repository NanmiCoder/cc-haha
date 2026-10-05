import { forwardRef, type MutableRefObject } from 'react'
import {
  BookOpen,
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
import { COMPOSER_KBD, COMPOSER_MENU_SECTION } from './composerMenuStyles'

/** One menu row: icon, then the name over its description (the 「素」 menu item). */
const ROW = 'flex min-h-8 w-full cursor-default items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]'

const SYSTEM_SLASH_COMMAND_ICONS: Record<string, LucideIcon> = {
  agent: Bot,
  mcp: Wrench,
  skills: Package,
  help: HelpCircle,
  status: CircleGauge,
  cost: CircleDollarSign,
  context: PanelTop,
  plugin: Package,
  memory: BookOpen,
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
  isSearching?: boolean
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
      isSearching = false,
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
          aria-labelledby={`${id}-label-${index}`}
          aria-describedby={`${id}-description-${index}`}
          title={[`/${command.name}`, command.argumentHint, command.description].filter(Boolean).join(' — ')}
          ref={(element) => { itemRefs.current[index] = element }}
          onClick={() => onSelect(command.name)}
          onMouseEnter={() => onHighlight(index)}
          className={`${ROW} ${
            index === selectedIndex
              ? 'bg-[var(--color-surface-hover)]'
              : 'hover:bg-[var(--color-surface-hover)]'
          }`}
        >
          <Icon
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]"
            strokeWidth={1.75}
          />
          <span className="grid min-w-0 flex-1 gap-px">
            <span id={`${id}-label-${index}`} className="truncate text-[13px] font-medium text-[var(--color-text-primary)]">
              /{command.name}
            </span>
            <span id={`${id}-description-${index}`} className="truncate text-xs text-[var(--color-text-tertiary)]">
              {command.description}
            </span>
          </span>
          {isSearching && command.argumentHint ? (
            <span className="max-w-[30%] shrink truncate font-mono text-[11px] text-[var(--color-text-tertiary)]" title={command.argumentHint}>
              {command.argumentHint}
            </span>
          ) : null}
        </div>
      )
    }

    return (
      <div
        ref={ref}
        onMouseDown={event => event.preventDefault()}
        className="absolute bottom-full left-0 right-0 z-[var(--z-dropdown)] mb-2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]"
      >
        {isSearching ? <div className={`${COMPOSER_MENU_SECTION} px-3 pt-2.5`}>
          {t('chat.slashSearchResults')}
        </div> : null}
        <div
          id={id}
          role="listbox"
          aria-label={t('chat.slashCommands')}
          className="max-h-[min(360px,45vh)] overflow-y-auto p-1"
        >
          {groups.system.length > 0 ? <div role="group" aria-label={t(isSearching ? 'chat.slashCommands' : 'chat.slashFrequent')}>
            {!isSearching ? <div className={COMPOSER_MENU_SECTION}>{t('chat.slashFrequent')}</div> : null}
            {groups.system.map(renderSystemCommand)}
          </div> : null}

          {([
            { kind: 'skill' as const, items: groups.skills, label: t('sidebar.skills'), offset: groups.system.length },
            { kind: 'plugin' as const, items: groups.plugins ?? [], label: t('chat.referencePlugins'), offset: groups.system.length + groups.skills.length },
          ]).map(group => group.items.length > 0 ? (
            <div key={group.kind} role="group" aria-label={group.label}>
              <div className={COMPOSER_MENU_SECTION}>{group.label}</div>
              {group.items.map((command, position) => {
                const index = group.offset + position
                const candidate = references.find(item => item.kind === group.kind && (item.name === command.name || item.id === command.name))
                const icon = safeMentionIcon(candidate?.icon)
                const Icon = referenceFallbackIcon(group.kind)
                const sourceLabel = skillSourceLabelKey(command.source)
                return <div
                  id={getSlashCommandOptionId(id, index)} key={command.name} role="option" tabIndex={-1}
                  aria-selected={index === selectedIndex} aria-labelledby={`${id}-label-${index}`} aria-describedby={`${id}-description-${index}`}
                  title={[candidate?.displayName || command.name, command.argumentHint, command.description].filter(Boolean).join(' — ')}
                  ref={element => { itemRefs.current[index] = element }}
                  onClick={() => onSelect(command.name)} onMouseEnter={() => onHighlight(index)}
                  className={`${ROW} ${index === selectedIndex ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'}`}>
                  {icon ? <img src={publicAssetPath(icon)} alt="" className="h-4 w-4 shrink-0 object-contain" /> : <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" strokeWidth={1.75} />}
                  <span className="grid min-w-0 flex-1 gap-px">
                    <span id={`${id}-label-${index}`} className="truncate text-[13px] font-medium text-[var(--color-text-primary)]">{candidate?.displayName || command.name}</span>
                    <span id={`${id}-description-${index}`} className="truncate text-xs text-[var(--color-text-tertiary)]">{command.description}</span>
                  </span>
                  {sourceLabel ? <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">{t(sourceLabel)}</span> : null}
                </div>
              })}
            </div>
          ) : null)}
        </div>
        {!isSearching ? <div className="px-3 pb-2 text-xs text-[var(--color-text-tertiary)]">{t('chat.slashSearchHint')}</div> : null}
        {showKeyboardHints ? (
          <div className="flex items-center gap-1.5 border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
            <kbd className={COMPOSER_KBD}>↑↓</kbd>
            <span>{t('chat.navigate')}</span>
            <kbd className={`${COMPOSER_KBD} ml-2`}>Enter</kbd>
            <span>{t('chat.select')}</span>
            <kbd className={`${COMPOSER_KBD} ml-2`}>Esc</kbd>
            <span>{t('chat.dismiss')}</span>
          </div>
        ) : null}
      </div>
    )
  },
)
