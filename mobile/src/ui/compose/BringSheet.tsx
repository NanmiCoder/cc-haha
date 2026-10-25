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
import type { RecentItem } from '../../core/recentSkills'
import { recentRepository } from './recentStore'
import { useBringExtras } from './useBringExtras'
import {
  applyBringSelection,
  assembleBringItems,
  bringEntries,
  bringEntryTitle,
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

export type MaterialKind = 'photos' | 'camera' | 'file'
const materials: { kind: MaterialKind; title: string; icon: IconName }[] = [
  { kind: 'photos', title: '相册', icon: 'image' },
  { kind: 'camera', title: '拍照', icon: 'camera' },
  { kind: 'file', title: '文件', icon: 'file' },
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
 * 多选结果行：可以勾选。连接器带状态点；不能选的行（要授权、在电脑上连接…）
 * 只显示一个标签，点一下提示该去电脑上做什么，不做假按钮。
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
      accessibilityLabel={`${item.token}，${item.description}${blocked ? `，${item.unavailable}` : ''}`}
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
        // 连接器：左边是 logo，状态点压在 logo 右下角。
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
 * 连接器二级页，按桌面分段：已连接、需要处理、推荐，最后是「浏览全部」展开其余。
 * 手机上不能授权也不能安装，所以没有按钮，只有说明。
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
              accessibilityLabel={browsing ? '收起全部连接器' : `浏览全部连接器，${rest.length} 个`}
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
                {browsing ? '收起' : `浏览全部（${rest.length}）`}
              </Text>
              <Icon name={browsing ? 'chevron-up' : 'chevron-down'} size={16} color={colors.chevron} strokeWidth={2.2} />
            </Pressable>
          </Card>
        </View>
      ) : null}
      {!hits.length ? (
        <Text style={{ paddingVertical: 24, textAlign: 'center', fontSize: 14, color: colors.ink3 }}>
          这台电脑上还没有可用的连接器
        </Text>
      ) : null}
    </View>
  )
}

/** 已选的小胶囊：点一下移除。 */
function SelectedChips({ selected, onRemove }: { selected: BringItem[]; onRemove(item: BringItem): void }) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Text style={{ fontSize: 13, color: colors.ink3 }}>已选</Text>
      {selected.map((item) => (
        <Pressable
          key={item.key}
          accessibilityRole="button"
          accessibilityLabel={`移除 ${item.token}`}
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
          accessibilityLabel="搜索技能、命令、连接器、Agent"
          value={value}
          onChangeText={onChange}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder="搜技能、命令、连接器、Agent"
          placeholderTextColor={colors.ink3}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={{ flex: 1, minWidth: 0, fontSize: 16, color: colors.ink, paddingVertical: 8 }}
        />
        {value ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清除搜索"
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
          accessibilityLabel="取消搜索"
          onPress={onCancel}
          style={{ height: 44, paddingLeft: 10, paddingRight: 4, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: colors.ink2 }}>取消</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

type Page = 'root' | BringGroup

/**
 * ＋ 带什么：半高是搜索、材料、最近用过和各类入口；点进入口或开始搜索就升到全高，
 * 结果可以多选，点「完成」一次带上。快速添加（最近用过右侧的 ＋）选一项就关。
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
  /** 选好了：新的草稿文字和技能引用。 */
  onApply(next: { draft: string; references: ComposerReference[] }): void
  /** 「运行方式」一组：Agent 团队（只对下一条消息生效）和操作电脑。 */
  team: boolean
  onTeam(value: boolean): void
  computer: ComputerUse
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
      // 每次打开都从头开始：半高、根页面、没有搜索词，输入框里已有的技能算已选。
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
  // 手机上做不了的事（授权、连接）：在搜索框下面说一句，几秒后收起。
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
            accessibilityLabel="返回"
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
            {loading ? '正在读取…' : '没有匹配的技能、命令或连接器'}
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
            {page === 'agent' ? '这台电脑上还没有可用的 Agent' : page === 'workflow' ? '这台电脑上还没有工作流' : '这一类现在没有可用的内容'}
          </Text>
        )
      ) : (
        <View>
          <View style={{ flexDirection: 'row', gap: 8, paddingTop: 2 }}>
            {materials.map((material) => (
              <Pressable
                key={material.kind}
                accessibilityRole="button"
                accessibilityLabel={`从${material.title}添加`}
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
              <SectionTitle title="最近用过" />
              <Card>
                {quick.map((item, index) => (
                  <View key={item.key}>
                    {index > 0 ? <Divider inset={14} /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`添加 ${item.token}，${item.description}`}
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
                        accessibilityLabel={`${entry.title}，${entry.count} 项`}
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
              这台电脑上暂时没有可带的技能或命令
            </Text>
          )}
          {/* 轻量档位不支持团队和操作电脑：和桌面一样整组不显示。 */}
          {lean ? null : (
            <>
              <SectionTitle title="运行方式" />
              <RunToggles
                visible={visible}
                client={client}
                team={team}
                onTeam={onTeam}
                lean={lean}
                computer={computer}
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
