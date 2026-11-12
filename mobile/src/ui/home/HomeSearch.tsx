import { useMemo, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { Text } from '../Text'
import { KeyboardViewport } from '../KeyboardViewport'
import { EmptyState, SearchField, TextButton, useColors } from '../kit'
import type { DashboardRow } from '../../core/dashboard'
import { inProject, matchesQuery, type Project } from './homeModel'
import { RowGroup } from './parts'
import { MoreRow, SearchRow } from './SessionRows'
import { plural } from '../../core/plural'

const page = 30

/** Search state: cancel · project filter chips · "Found N tasks in …". Only filters the list without changing any home counts. */
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
              placeholder="Search tasks or projects"
              autoFocus
            />
          </View>
          <TextButton title="Cancel" color={colors.ink} onPress={onCancel} />
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          // ScrollView Shrinkable by default: with many results below Yoga squeezes this row proportionally and the chips get clipped.
          style={{ flexGrow: 0, flexShrink: 0, marginTop: 12 }}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        >
          <FilterChip
            label="All projects"
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
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 }}
        >
          {results.length ? (
            <>
              <Text
                accessibilityLiveRegion="polite"
                style={{ paddingVertical: 8, paddingHorizontal: 4, fontSize: 13, lineHeight: 18, color: colors.ink3 }}
              >
                Found {plural(results.length, 'task')} in {scope || 'all projects'}
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
              title="No tasks found"
              detail={
                scope ? `${scope} has no matching tasks; try another keyword or look at all projects.` : 'Try another title or project name.'
              }
            />
          )}
        </ScrollView>
      </View>
    </KeyboardViewport>
  )
}

/** Filter chip from the design: 34 high, radius 17 (kit Chip is the generic 36 high size). */
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
