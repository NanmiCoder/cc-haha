import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, View } from 'react-native'
import type { ApiClient } from '../core/client'
import { DirectoryBrowserController, type DirectoryBrowserState } from '../core/directoryBrowser'
import { Text } from './Text'
import { Button, Callout, Icon, Mono, Separator, useColors } from './kit'
import { ChoiceRow } from './newtask/ChoiceRow'

/** Browses the connected computer, never the phone's local document storage. */
export function DirectoryBrowser({ client, path, onSelect, bottomInset = 16, busy }: {
  client: ApiClient | null
  path: string
  onSelect(path: string): void
  bottomInset?: number
  busy?: boolean
}) {
  const colors = useColors()
  const [state, setState] = useState<DirectoryBrowserState>({ loading: true })
  const controller = useRef<DirectoryBrowserController | null>(null)
  useEffect(() => {
    if (!client) return
    const next = new DirectoryBrowserController(client, setState)
    controller.current = next
    void next.open(path || undefined)
    return () => {
      next.dispose()
      controller.current = null
    }
  }, [client, path])
  const listing = state.listing
  const open = (next?: string) => { void controller.current?.open(next) }
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, gap: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Button title="电脑主目录" variant="plain" disabled={busy || !client} onPress={() => open()} />
          <Button title="上一级" variant="plain" disabled={busy || !listing || listing.parentPath === listing.currentPath} onPress={() => open(listing?.parentPath)} />
        </View>
        {listing ? <Mono selectable style={{ fontSize: 13, color: colors.ink2 }}>{listing.currentPath}</Mono> : null}
        {!client ? <Callout>请先连接电脑，再浏览目录。</Callout> : null}
        {state.error ? (
          <View accessibilityLiveRegion="polite" style={{ gap: 6 }}>
            <Callout>{state.error}</Callout>
            <Button title="重试读取目录" variant="plain" disabled={busy || state.loading} onPress={() => { void controller.current?.retry() }} />
          </View>
        ) : null}
        {state.loading && client ? <ActivityIndicator accessibilityLabel="正在读取电脑目录" color={colors.ink3} /> : null}
      </View>
      <FlatList
        data={listing?.entries ?? []}
        keyExtractor={item => item.path}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, flexGrow: 1 }}
        ItemSeparatorComponent={() => <Separator inset={14} />}
        renderItem={({ item }) => (
          <ChoiceRow
            title={item.name}
            leading={<Icon name="folder" size={20} color={colors.ink3} />}
            trailingText="›"
            accessibilityLabel={`打开目录 ${item.name}`}
            disabled={busy || state.loading}
            onPress={() => open(item.path)}
          />
        )}
        ListEmptyComponent={!state.loading && !state.error && client ? (
          <Text style={{ color: colors.ink3, textAlign: 'center', marginTop: 24 }}>这个目录没有子目录，可以直接选择。</Text>
        ) : undefined}
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: bottomInset }}>
        <Button title="使用这个目录" size="lg" disabled={busy || !client || state.loading || !!state.error || !listing} onPress={() => { if (listing) onSelect(listing.currentPath) }} />
      </View>
    </View>
  )
}
