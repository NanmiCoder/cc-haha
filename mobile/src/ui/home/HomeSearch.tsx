import { useMemo, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { Text } from '../Text'
import { KeyboardViewport } from '../KeyboardViewport'
import { EmptyState, SearchField, TextButton, useColors } from '../kit'
import type { DashboardRow } from '../../core/dashboard'
import { inProject, matchesQuery, type Project } from './homeModel'
import { RowGroup } from './parts'
import { MoreRow, SearchRow } from './SessionRows'

const page = 30

/** 搜索态：取消 · 项目筛选 chips · “在…中找到 N 个任务”。只过滤列表，不改首页任何计数。 */
export function HomeSearch({
  rows,
  projects,
  initialProject,
  onCancel,
  onOpen,
}: {
  rows: DashboardRow[]
  projects: Project[]
  initialProject: string | null
  onCancel(): void
  onOpen(row: DashboardRow): void
}) {
  const colors = useColors()
  const [query, setQuery] = useState('')
  const [project, setProject] = useState<string | null>(initialProject)
  const [shown, setShown] = useState(page)
  const results = useMemo(
    () => rows.filter((row) => inProject(row, project) && matchesQuery(row, query)),
    [rows, project, query]
  )
  const scope = projects.find((item) => item.key === project)?.name
  const visible = results.slice(0, shown)
  return (
    <KeyboardViewport style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingHorizontal: 16,
            paddingTop: 4,
          }}
        >
          <View style={{ flex: 1 }}>
            <SearchField
              value={query}
              onChangeText={(value) => {
                setQuery(value)
                setShown(page)
              }}
              placeholder="搜索任务或项目"
              autoFocus
            />
          </View>
          <TextButton title="取消" color={colors.ink} onPress={onCancel} />
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={{ flexGrow: 0, marginTop: 12 }}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        >
          <FilterChip
            label="全部项目"
            selected={project === null}
            onPress={() => {
              setProject(null)
              setShown(page)
            }}
          />
          {projects.map((item) => (
            <FilterChip
              key={item.key}
              label={item.name}
              selected={project === item.key}
              onPress={() => {
                setProject(item.key)
                setShown(page)
              }}
            />
          ))}
        </ScrollView>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 }}
        >
          {results.length ? (
            <>
              <Text
                accessibilityLiveRegion="polite"
                style={{ paddingVertical: 8, paddingHorizontal: 4, fontSize: 13, lineHeight: 18, color: colors.ink3 }}
              >
                在{scope ? ` ${scope} ` : '全部项目'}中找到 {results.length} 个任务
              </Text>
              <RowGroup>
                {visible.map((row) => (
                  <SearchRow key={row.session.id} row={row} query={query} onPress={() => onOpen(row)} />
                ))}
                {results.length > visible.length ? (
                  <MoreRow
                    count={results.length - visible.length}
                    onPress={() => setShown((value) => value + page)}
                  />
                ) : null}
              </RowGroup>
            </>
          ) : (
            <EmptyState
              icon="search"
              title="没有找到任务"
              detail={
                scope ? `${scope} 里没有匹配的任务，换个关键词或看看全部项目。` : '换个标题或项目名称试试。'
              }
            />
          )}
        </ScrollView>
      </View>
    </KeyboardViewport>
  )
}

/** 设计稿的筛选 chip：34 高、圆角 17（kit Chip 是 36 高的通用尺寸）。 */
function FilterChip({
  label,
  selected,
  onPress,
}: {
  label: string
  selected: boolean
  onPress(): void
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 34,
        paddingHorizontal: 14,
        borderRadius: 17,
        justifyContent: 'center',
        backgroundColor: selected ? colors.btn : colors.card,
        boxShadow: selected ? undefined : `inset 0 0 0 1px ${colors.hair}`,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text
        numberOfLines={1}
        style={{
          fontSize: 14,
          fontWeight: selected ? '600' : '400',
          color: selected ? colors.btnInk : colors.ink,
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
}
