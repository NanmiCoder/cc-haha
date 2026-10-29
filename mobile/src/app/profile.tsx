import { useCallback } from 'react'
import { router } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { useConnection } from '../state/AppContext'
import { loadProfileOverview } from '../core/profile'
import { useFocusedResource } from '../core/useFocusedResource'
import type { ApiClient } from '../core/client'
import { Button, EmptyState, FloatingButton, InlineError, Loading, NavBar, ScreenView, useColors } from '../ui/kit'
import { Text } from '../ui/Text'
import { ProfileContent, ProfileSkeleton } from '../ui/profile/ProfileContent'

export default function Profile() {
  const { host, client, error } = useConnection()
  const colors = useColors()
  return (
    <ScreenView background={colors.card}>
      <NavBar floating title="个人主页" right={<FloatingButton icon="laptop" label="切换电脑" onPress={() => router.push('/hosts')} />} />
      {!host ? (
        <EmptyState icon="laptop" title="连接电脑后查看个人主页" detail="头像、昵称和使用记录来自你连接的电脑。" action={<Button title="连接电脑" onPress={() => router.push('/connect')} />} />
      ) : !client ? (
        error ? <InlineError text={error} /> : <Loading />
      ) : (
        <ProfileBody key={`${host.id}:${host.url}`} client={client} hostName={host.name} />
      )}
    </ScreenView>
  )
}

function ProfileBody({ client, hostName }: { client: ApiClient; hostName: string }) {
  const colors = useColors()
  const load = useCallback((signal: AbortSignal) => loadProfileOverview(client, signal), [client])
  const resource = useFocusedResource(load)
  const value = resource.value
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 40, paddingTop: 20, maxWidth: 520, width: '100%', alignSelf: 'center' }}>
      {resource.loading ? <ProfileSkeleton /> : value ? (
        <>
          <ProfileContent overview={value} onRetry={() => void resource.refresh()} />
          <View style={{ borderTopWidth: 1, borderTopColor: colors.hair, paddingTop: 16, marginTop: 26, gap: 6 }}>
            <Text style={{ color: colors.ink3, fontSize: 11, lineHeight: 17 }}>来自 {hostName} · 包含缓存读取</Text>
            {value.profile ? <Text style={{ color: colors.ink3, fontSize: 11, lineHeight: 17 }}>头像和昵称在电脑端「个人主页」中编辑。</Text> : null}
          </View>
        </>
      ) : <InlineError text={resource.error} />}
    </ScrollView>
  )
}
