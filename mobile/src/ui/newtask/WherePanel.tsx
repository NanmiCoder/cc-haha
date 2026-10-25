import { useState } from 'react'
import { FlatList, Pressable, View } from 'react-native'
import type { ApiClient } from '../../core/client'
import { displayPath, type RecentProject } from '../../core/newTask'
import { DirectoryBrowser } from '../DirectoryBrowser'
import { Text } from '../Text'
import { Icon, SearchField, Separator, useColors } from '../kit'
import { ChoiceRow } from './ChoiceRow'

/** Pick a computer directory, then return to the task draft. Git has its own sheet. */
export function WherePanel({ projects, path, onPath, onBack, bottomInset, busy, client }: {
  projects: RecentProject[]
  path: string
  onPath(path: string): void
  onBack(): void
  bottomInset: number
  busy?: boolean
  client: ApiClient | null
}) {
  const colors = useColors()
  const [view, setView] = useState<'recent' | 'browse'>('recent')
  const [search, setSearch] = useState('')
  const select = (selected: string) => {
    if (selected !== path) onPath(selected)
    onBack()
  }
  const query = search.trim().toLocaleLowerCase()
  const filtered = projects.filter(project => `${project.projectName} ${project.realPath}`.toLocaleLowerCase().includes(query))
  return (
    <View style={{ flex: 1 }}>
      <View style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回新任务" onPress={onBack} style={{ minHeight: 44, justifyContent: 'center', width: 80 }}>
          <Icon name="chevron-left" size={22} color={colors.ink2} />
        </Pressable>
        <Text accessibilityRole="header" style={{ flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: colors.ink }}>工作目录</Text>
        <View style={{ width: 80 }} />
      </View>
      <View style={{ paddingHorizontal: 16, gap: 12, paddingBottom: 12 }}>
        <Text style={{ fontSize: 13, color: colors.ink3 }}>选择这台电脑上的项目目录</Text>
        <View style={{ flexDirection: 'row', backgroundColor: colors.fill, borderRadius: 12, padding: 3 }}>
          {(['recent', 'browse'] as const).map(tab => (
            <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected: view === tab }} onPress={() => setView(tab)} style={{ flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: view === tab ? colors.card : 'transparent' }}>
              <Text style={{ fontSize: 15, fontWeight: view === tab ? '600' : '400', color: colors.ink }}>{tab === 'recent' ? '最近项目' : '浏览目录'}</Text>
            </Pressable>
          ))}
        </View>
        {view === 'recent' ? <SearchField value={search} onChangeText={setSearch} placeholder="搜索项目或路径" /> : null}
      </View>
      {view === 'browse' ? <DirectoryBrowser client={client} path={path} onSelect={select} bottomInset={bottomInset} busy={busy} /> : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.realPath}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomInset }}
          ItemSeparatorComponent={() => <Separator inset={14} />}
          renderItem={({ item }) => <ChoiceRow title={item.projectName} detail={displayPath(item.realPath)} detailMono selected={item.realPath === path} disabled={busy} accessibilityLabel={`选择项目 ${item.projectName}，${item.realPath}`} onPress={() => select(item.realPath)} />}
          ListEmptyComponent={<Text style={{ color: colors.ink3, textAlign: 'center', paddingVertical: 24 }}>{query ? '没有匹配的项目' : '还没有最近项目，请浏览电脑目录。'}</Text>}
          ListFooterComponent={<ChoiceRow title="浏览电脑上的目录" leading={<Icon name="folder" size={20} color={colors.ink3} />} onPress={() => setView('browse')} />}
        />
      )}
    </View>
  )
}
