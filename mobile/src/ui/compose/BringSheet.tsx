import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import { Text } from '../Text'
import { DetentSheet } from '../DetentSheet'
import type { Detent } from '../detents'
import { Button, Callout, Dot, Icon, Mono, Spinner, useColors, type IconName } from '../kit'
import { Glyph } from './glyphs'
import { ConnectorIcon } from '../ConnectorIcon'
import type { ApiClient } from '../../core/client'
import type { ComposerCandidate, ComposerReference } from '../../core/composerReferences'
import { computerUseReference, isComputerUseReference } from '../../core/computerUse'
import type { RecentItem } from '../../core/recentSkills'
import { recentRepository } from './recentStore'
import { useBringExtras } from './useBringExtras'
import {
  applyBringSelection,
  assembleBringItems,
  bringEntries,
  bringEntryTitle,
  bringItemFromReference,
  connectorSectionTitle,
  doneLabel,
  groupItems,
  initialSelection,
  isBringSelected,
  resolveRecents,
  searchBringItems,
  showDone,
  splitByRanges,
  toRecent,
  toggleBringItem,
  type BringGroup,
  type BringHit,
  type BringItem,
  type ConnectorSection,
  type Range,
} from './bringModel'
import type { ComputerUse } from '../../core/useComputerUse'
import { RunToggles } from './RunToggles'
import { plural } from '../../core/plural'

export type MaterialKind = 'photos' | 'camera' | 'file'
const materials: { kind: MaterialKind; title: string; icon: IconName }[] = [
  { kind: 'photos', title: 'Photo library', icon: 'image' },
  { kind: 'camera', title: 'Take photo', icon: 'camera' },
  { kind: 'file', title: 'Files', icon: 'file' },
]

function EntryIcon({ group, color }: { group: BringGroup; color: string }) {
  if (group === 'skill') return <Icon name="sparkle" size={16} color={color} />
  if (group === 'command') return <Icon name="terminal" size={16} color={color} />
  if (group === 'connector') return <Glyph name="plug" size={16} color={color} />
  if (group === 'agent') return <Glyph name="bot" size={16} color={color} />
  return <Glyph name="workflow" size={16} color={color} />
}

function Highlighted({ text, ranges, style, numberOfLines = 1, mono }: {
  text: string
  ranges: Range[]
  style: object
  numberOfLines?: number
  mono?: boolean
}) {
  const colors = useColors()
  const Body = mono ? Mono : Text
  return (
    <Body numberOfLines={numberOfLines} style={style}>
      {splitByRanges(text, ranges).map((part, index) =>
        part.hit ? (
          <Text key={index} style={{ backgroundColor: colors.runSoft, color: colors.run }}>{part.text}</Text>
        ) : (
          part.text
        )
      )}
    </Body>
  )
}

function SectionTitle({ title, count }: { title: string; count?: number }) {
  const colors = useColors()
  return (
    <Text
      accessibilityRole="header"
      style={{ paddingTop: 12, paddingBottom: 6, paddingHorizontal: 4, fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.ink2 }}
    >
      {title}
      {count !== undefined ? <Mono style={{ fontWeight: '400', color: colors.ink3 }}> · {count}</Mono> : null}
    </Text>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  const colors = useColors()
  return <View style={{ backgroundColor: colors.card, borderRadius: 14 }}>{children}</View>
}

function Divider({ inset }: { inset: number }) {
  const colors = useColors()
  return <View style={{ height: 1, backgroundColor: colors.hair, marginLeft: inset }} />
}

/**
 * Multi-select result row: can be checked. Connectors have a status dot; unselectable rows (needs authorization, connect on the computer…)
 * show only a label, and tapping hints what to do on the computer, with no fake button.
 */
function ResultRow({ hit, selected, onPress, onNotice }: {
  hit: BringHit
  selected: boolean
  onPress(): void
  onNotice(text: string): void
}) {
  const colors = useColors()
  const { item } = hit
  const mono = item.token.startsWith('/')
  const blocked = !!item.unavailable
  const dotColor = item.dot === 'ok' ? colors.ok : item.dot === 'attn' ? colors.attnDot : undefined
  return (
    <Pressable
      accessibilityRole={blocked ? 'button' : 'checkbox'}
      accessibilityLabel={`${item.token}, ${item.description}${blocked ? `, ${item.unavailable}` : ''}`}
      accessibilityHint={blocked ? item.notice : undefined}
      accessibilityState={blocked ? undefined : { checked: selected }}
      aria-checked={blocked ? undefined : selected}
      onPress={blocked ? () => item.notice && onNotice(item.notice) : onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 7,
        paddingHorizontal: 14,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      {item.group === 'connector' ? (
        // Connector: logo on the left, with the status dot over the logo's bottom right corner.
        <View style={{ width: 30, height: 30 }}>
          <ConnectorIcon id={item.iconId} size={30} />
          {dotColor ? (
            <View style={{ position: 'absolute', right: -3, bottom: -3, padding: 2, borderRadius: 7, backgroundColor: colors.card }}>
              <Dot color={dotColor} size={8} />
            </View>
          ) : null}
        </View>
      ) : dotColor ? (
        <Dot color={dotColor} size={8} />
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Highlighted
          text={item.token}
          ranges={hit.titleRanges}
          mono={mono}
          style={{ fontSize: 14, lineHeight: 20, fontWeight: '500', color: colors.ink }}
        />
        {item.description ? (
          <Highlighted
            text={item.description}
            ranges={hit.descriptionRanges}
            style={{ fontSize: 13, lineHeight: 18, color: item.tone === 'attn' ? colors.attnInk : colors.ink3 }}
          />
        ) : null}
      </View>
      {item.unavailable ? (
        item.tone === 'attn' ? (
          <View style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.attnSoft, justifyContent: 'center' }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.attn }}>{item.unavailable}</Text>
          </View>
        ) : (
          <Text style={{ flexShrink: 0, fontSize: 13, color: colors.ink3 }}>{item.unavailable}</Text>
        )
      ) : (
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 12,
            backgroundColor: selected ? colors.run : 'transparent',
            boxShadow: selected ? undefined : `inset 0 0 0 1.5px ${colors.chevron}`,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {selected ? <Icon name="check" size={14} color="#FFFFFF" strokeWidth={3} /> : null}
        </View>
      )}
    </Pressable>
  )
}

function ResultList({ hits, selected, onToggle, onNotice }: {
  hits: BringHit[]
  selected: BringItem[]
  onToggle(item: BringItem): void
  onNotice(text: string): void
}) {
  const colors = useColors()
  return (
    <View style={{ backgroundColor: colors.card, borderRadius: 14, overflow: 'hidden' }}>
      {hits.map((hit, index) => (
        <View key={hit.item.key}>
          {index > 0 ? <Divider inset={14} /> : null}
          <ResultRow hit={hit} selected={isBringSelected(selected, hit.item)} onPress={() => onToggle(hit.item)} onNotice={onNotice} />
        </View>
      ))}
    </View>
  )
}

const connectorSectionOrder: ConnectorSection[] = ['connected', 'attention', 'suggested']

/**
 * Connectors subpage, sectioned like desktop: connected, needs attention, recommended, and finally "Browse all" expanding the rest.
 * The phone can neither authorize nor install, so there are no buttons, only descriptions.
 */
function ConnectorPage({ hits, selected, onToggle, onNotice, browsing, onBrowse }: {
  hits: BringHit[]
  selected: BringItem[]
  onToggle(item: BringItem): void
  onNotice(text: string): void
  browsing: boolean
  onBrowse(value: boolean): void
}) {
  const colors = useColors()
  const inSection = (section: ConnectorSection) => hits.filter((hit) => hit.item.section === section)
  const rest = inSection('rest')
  return (
    <View>
      {connectorSectionOrder.map((section) => {
        const list = inSection(section)
        return list.length ? (
          <View key={section}>
            <SectionTitle title={connectorSectionTitle[section]} />
            <ResultList hits={list} selected={selected} onToggle={onToggle} onNotice={onNotice} />
          </View>
        ) : null
      })}
      {browsing && rest.length ? (
        <View>
          <SectionTitle title={connectorSectionTitle.rest} />
          <ResultList hits={rest} selected={selected} onToggle={onToggle} onNotice={onNotice} />
        </View>
      ) : null}
      {rest.length ? (
        <View style={{ paddingTop: 12 }}>
          <Card>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={browsing ? 'Collapse all connectors' : `Browse all connectors, ${rest.length}`}
              accessibilityState={{ expanded: browsing }}
              onPress={() => onBrowse(!browsing)}
              style={({ pressed }) => ({
                height: 48,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 14,
                borderRadius: 14,
                backgroundColor: pressed ? colors.fill : 'transparent',
              })}
            >
              <Glyph name="plug" size={16} color={colors.ink2} />
              <Text style={{ flex: 1, fontSize: 16, color: colors.ink }}>
                {browsing ? 'Collapse' : `Browse all (${rest.length})`}
              </Text>
              <Icon name={browsing ? 'chevron-up' : 'chevron-down'} size={16} color={colors.chevron} strokeWidth={2.2} />
            </Pressable>
          </Card>
        </View>
      ) : null}
      {!hits.length ? (
        <Text style={{ paddingVertical: 24, textAlign: 'center', fontSize: 14, color: colors.ink3 }}>
          No connectors available on this computer yet
        </Text>
      ) : null}
    </View>
  )
}

/** Selected small capsule: tap to remove. */
function SelectedChips({ selected, onRemove }: { selected: BringItem[]; onRemove(item: BringItem): void }) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Text style={{ fontSize: 13, color: colors.ink3 }}>Selected</Text>
      {selected.map((item) => (
        <Pressable
          key={item.key}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${item.token}`}
          onPress={() => onRemove(item)}
          style={{ height: 44, justifyContent: 'center' }}
        >
          <View
            style={{
              height: 32,
              paddingLeft: 11,
              paddingRight: 8,
              borderRadius: 16,
              backgroundColor: colors.runTint,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {item.token.startsWith('/') ? (
              <Mono style={{ fontSize: 14, fontWeight: '500', color: colors.run }}>{item.token}</Mono>
            ) : (
              <Text style={{ fontSize: 14, fontWeight: '500', color: colors.run }}>{item.token}</Text>
            )}
            <Icon name="x" size={13} color={colors.run} strokeWidth={2.6} />
          </View>
        </Pressable>
      ))}
    </View>
  )
}

function SearchBar({ value, onChange, focused, onFocus, onBlur, onCancel, inputRef }: {
  value: string
  onChange(value: string): void
  focused: boolean
  onFocus(): void
  onBlur(): void
  onCancel(): void
  inputRef: React.RefObject<ComponentRef<typeof TextInput> | null>
}) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View
        style={{
          flex: 1,
          minWidth: 0,
          height: 44,
          borderRadius: 12,
          backgroundColor: focused ? colors.card : colors.fill,
          borderWidth: 1.5,
          borderColor: focused ? colors.run : 'transparent',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingLeft: 12,
        }}
      >
        <Icon name="search" size={18} color={colors.ink3} strokeWidth={2} />
        <TextInput
          ref={inputRef}
          accessibilityLabel="Search skills, commands, connectors, Agent"
          value={value}
          onChangeText={onChange}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder="Search skills, commands, connectors, Agent"
          placeholderTextColor={colors.ink3}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={{ flex: 1, minWidth: 0, fontSize: 16, color: colors.ink, paddingVertical: 8 }}
        />
        {value ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            onPress={() => onChange('')}
            style={{ width: 44, height: 44, marginRight: -4, alignItems: 'center', justifyContent: 'center' }}
          >
            <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: colors.chevron, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="x" size={10} color="#FFFFFF" strokeWidth={3.5} />
            </View>
          </Pressable>
        ) : null}
      </View>
      {focused || value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel search"
          onPress={onCancel}
          style={{ height: 44, paddingLeft: 10, paddingRight: 4, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: colors.ink2 }}>Cancel</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

type Page = 'root' | BringGroup

/**
 * + Bring: half height shows search, materials, recently used and category entries; entering a category or starting a search rises to full height, 
 * results can be multi-selected and brought in at once with Done. Quick add (the + right of Recently used) closes after one pick.
 */
export function BringSheet({
  visible,
  onClose,
  client,
  workDir,
  lean,
  candidates,
  loading,
  error,
  references,
  draft,
  picking,
  onPick,
  onApply,
  team,
  onTeam,
  computer,
  onComputerSelected,
}: {
  visible: boolean
  onClose(): void
  client: ApiClient | null
  workDir?: string
  lean: boolean
  candidates: ComposerCandidate[]
  loading: boolean
  error: string
  references: ComposerReference[]
  draft: string
  picking: MaterialKind | null
  onPick(kind: MaterialKind): void
  /** Picked: new draft text and skill references. */
  onApply(next: { draft: string; references: ComposerReference[] }): void
  /** The "Run mode" group: agent team (applies to the next message only) and computer use. */
  team: boolean
  onTeam(value: boolean): void
  computer: ComputerUse
  onComputerSelected(value: boolean): void
}) {
  const colors = useColors()
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const [detent, setDetent] = useState<Detent>('half')
  const [teamAccepted, setTeamAccepted] = useState(false)
  const [page, setPage] = useState<Page>('root')
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [initial, setInitial] = useState<BringItem[]>([])
  const [selected, setSelected] = useState<BringItem[]>([])
  const [recents, setRecents] = useState<RecentItem[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [notice, setNotice] = useState('')
  const [shown, setShown] = useState(false)
  if (shown !== visible) {
    setShown(visible)
    if (visible) {
      // Every open starts fresh: half height, root page, no search term, and skills already in the input count as selected.
      const start = initialSelection(references)
      setDetent('half')
      setPage('root')
      setQuery('')
      setFocused(false)
      setBrowsing(false)
      setNotice('')
      setInitial(start)
      setSelected(start)
    }
  }
  useEffect(() => {
    if (!visible) return
    let alive = true
    recentRepository.load().then((value) => alive && setRecents(value)).catch(() => {})
    return () => {
      alive = false
    }
  }, [visible])
  const extras = useBringExtras(client, workDir, visible && !lean)
  const items = useMemo(() => assembleBringItems({ candidates, lean, extras }), [candidates, lean, extras])
  const cards = useMemo(
    () =>
      bringEntries(
        items,
        lean
          ? { connector: false, agent: false, workflow: false }
          : { connector: !!extras.connectors, agent: !!extras.agents, workflow: !!extras.workflows }
      ),
    [items, lean, extras]
  )
  const hasEntries = cards.length > 0
  const quick = useMemo(() => resolveRecents(recents, items), [recents, items])
  const searching = query.trim().length > 0
  const results = useMemo(() => searchBringItems(items, query), [items, query])

  function finish(chosen: BringItem[], base: BringItem[]) {
    const next = applyBringSelection({ draft, selected: chosen, initial: base })
    if (next.added.length) {
      void recentRepository.record(next.added.map(toRecent)).catch(() => {})
    }
    onApply({ draft: next.draft, references: next.references })
  }
  const toggle = (item: BringItem) => setSelected((value) => toggleBringItem(value, item))
  // Things the phone cannot do (authorize, connect): say one line under the search box, dismissed after a few seconds.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 3200)
    return () => clearTimeout(timer)
  }, [notice])
  const cancelSearch = () => {
    setQuery('')
    setFocused(false)
    input.current?.blur()
    if (page === 'root') setDetent('half')
  }
  const back = () => {
    setPage('root')
    setBrowsing(false)
    setNotice('')
    if (!searching) setDetent('half')
  }
  const listed = page === 'root' ? [] : groupItems(items, page)
  const listHits: BringHit[] = listed.map((item) => ({ item, titleRanges: [], descriptionRanges: [] }))
  const footerVisible = showDone({ page: page === 'root' ? 'root' : 'list', searching, selected, initial })
  const chipsVisible = selected.length > 0 && (searching || page !== 'root')

  return (
    <DetentSheet
      visible={visible}
      onClose={onClose}
      detent={detent}
      onDetentChange={setDetent}
      title={page !== 'root' ? bringEntryTitle[page] : undefined}
      left={
        page !== 'root' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={back}
            style={{ width: 44, height: 44, marginLeft: -12, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="chevron-left" size={22} color={colors.ink} strokeWidth={2.2} />
          </Pressable>
        ) : undefined
      }
      header={
        <View style={{ gap: 4 }}>
          <SearchBar
            value={query}
            onChange={(value) => {
              setQuery(value)
              if (value.trim()) setDetent('full')
            }}
            focused={focused}
            onFocus={() => {
              setFocused(true)
              setDetent('full')
            }}
            onBlur={() => setFocused(false)}
            onCancel={cancelSearch}
            inputRef={input}
          />
          {chipsVisible ? <SelectedChips selected={selected} onRemove={toggle} /> : null}
          {notice ? (
            <View accessibilityLiveRegion="polite">
              <Callout tone="info">{notice}</Callout>
            </View>
          ) : null}
        </View>
      }
      footer={
        footerVisible ? (
          <Button
            title={doneLabel(selected.length)}
            size="lg"
            onPress={() => finish(selected, initial)}
          />
        ) : undefined
      }
    >
      {searching ? (
        results.length ? (
          results.map((group) => (
            <View key={group.group}>
              <SectionTitle title={group.title} count={group.hits.length} />
              <ResultList hits={group.hits} selected={selected} onToggle={toggle} onNotice={setNotice} />
            </View>
          ))
        ) : (
          <Text style={{ paddingVertical: 24, textAlign: 'center', fontSize: 14, color: colors.ink3 }}>
            {loading ? 'Loading…' : 'No matching skills, commands or connectors'}
          </Text>
        )
      ) : page === 'connector' ? (
        <ConnectorPage
          hits={listHits}
          selected={selected}
          onToggle={toggle}
          onNotice={setNotice}
          browsing={browsing}
          onBrowse={setBrowsing}
        />
      ) : page !== 'root' ? (
        listHits.length ? (
          <ResultList hits={listHits} selected={selected} onToggle={toggle} onNotice={setNotice} />
        ) : (
          <Text style={{ paddingVertical: 24, textAlign: 'center', fontSize: 14, color: colors.ink3 }}>
            {page === 'agent' ? 'No available on this computer yet: Agent' : page === 'workflow' ? 'No workflows on this computer yet' : 'Nothing available in this category right now'}
          </Text>
        )
      ) : (
        <View>
          <View style={{ flexDirection: 'row', gap: 8, paddingTop: 2 }}>
            {materials.map((material) => (
              <Pressable
                key={material.kind}
                accessibilityRole="button"
                accessibilityLabel={`Add from ${material.title}`}
                accessibilityState={{ disabled: !!picking, busy: picking === material.kind }}
                disabled={!!picking}
                onPress={() => onPick(material.kind)}
                style={({ pressed }) => ({
                  flex: 1,
                  height: 44,
                  borderRadius: 12,
                  backgroundColor: colors.card,
                  boxShadow: `inset 0 0 0 1px ${colors.hair}`,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 7,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                {picking === material.kind ? <Spinner size={18} /> : <Icon name={material.icon} size={18} color={colors.ink2} />}
                <Text style={{ fontSize: 14, color: colors.ink }}>{material.title}</Text>
              </Pressable>
            ))}
          </View>
          {quick.length ? (
            <View>
              <SectionTitle title="Recently used" />
              <Card>
                {quick.map((item, index) => (
                  <View key={item.key}>
                    {index > 0 ? <Divider inset={14} /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${item.token}, ${item.description}`}
                      onPress={() => finish(isBringSelected(selected, item) ? selected : [...selected, item], initial)}
                      style={({ pressed }) => ({
                        height: 48,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        paddingHorizontal: 14,
                        backgroundColor: pressed ? colors.fill : 'transparent',
                      })}
                    >
                      <Mono numberOfLines={1} style={{ flexShrink: 0, maxWidth: '55%', fontSize: 14, color: colors.run }}>
                        {item.token}
                      </Mono>
                      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 14, color: colors.ink3 }}>
                        {item.description}
                      </Text>
                      <Icon name="plus" size={18} color={colors.ink3} />
                    </Pressable>
                  </View>
                ))}
              </Card>
            </View>
          ) : null}
          <View style={{ height: 14 }} />
          {hasEntries ? (
            <View style={{ gap: 12 }}>
              {cards.map((card) => (
                <Card key={card[0]!.group}>
                  {card.map((entry, index) => (
                    <View key={entry.group}>
                      {index > 0 ? <Divider inset={54} /> : null}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${entry.title}, ${plural(entry.count, 'item')}`}
                        onPress={() => {
                          setPage(entry.group)
                          setDetent('full')
                        }}
                        style={({ pressed }) => ({
                          height: 48,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                          paddingHorizontal: 14,
                          backgroundColor: pressed ? colors.fill : 'transparent',
                        })}
                      >
                        <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: colors.fill, alignItems: 'center', justifyContent: 'center' }}>
                          <EntryIcon group={entry.group} color={colors.ink2} />
                        </View>
                        <Text style={{ flex: 1, fontSize: 16, color: colors.ink }}>{entry.title}</Text>
                        <Mono style={{ fontSize: 14, color: colors.ink3 }}>{entry.count}</Mono>
                        <Icon name="chevron-right" size={16} color={colors.chevron} strokeWidth={2.2} />
                      </Pressable>
                    </View>
                  ))}
                </Card>
              ))}
            </View>
          ) : loading ? (
            <View style={{ padding: 16, alignItems: 'center' }}>
              <Spinner size={18} />
            </View>
          ) : error ? (
            <Text style={{ padding: 8, fontSize: 14, color: colors.err }}>{error}</Text>
          ) : (
            <Text style={{ padding: 16, textAlign: 'center', fontSize: 14, color: colors.ink3 }}>
              No skills or commands to bring on this computer yet
            </Text>
          )}
          {/* The light tier does not support teams or computer use: like desktop the whole group is hidden. */}
          {lean ? null : (
            <>
              <SectionTitle title="Run mode" />
              <RunToggles
                visible={visible}
                client={client}
                team={team}
                onTeam={onTeam}
                lean={lean}
                computer={computer}
                computerSelected={selected.some((item) => item.reference && isComputerUseReference(item.reference))}
                onComputerSelected={(value) => {
                  setSelected((previous) => value
                    ? previous.some((item) => item.reference && isComputerUseReference(item.reference))
                      ? previous
                      : [...previous, bringItemFromReference({ ...computerUseReference })]
                    : previous.filter((item) => !item.reference || !isComputerUseReference(item.reference)))
                  onComputerSelected(value)
                }}
                accepted={teamAccepted}
                onAccept={() => setTeamAccepted(true)}
              />
            </>
          )}
        </View>
      )}
    </DetentSheet>
  )
}
