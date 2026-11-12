import { useCallback } from 'react'
import { router } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { useConnection } from '../state/AppContext'
import { isH5 } from '../state/h5'
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
      <NavBar
        floating
        title="Profile"
        right={isH5 ? undefined : <FloatingButton icon="laptop" label="Switch computer" onPress={() => router.push('/hosts')} />}
      />
      {!host ? (
        <EmptyState icon="laptop" title="Connect a computer to view your profile" detail="Avatar, nickname and usage records come from your connected computer." action={<Button title="Connect computer" onPress={() => router.push('/connect')} />} />
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
            <Text style={{ color: colors.ink3, fontSize: 11, lineHeight: 17 }}>From {hostName} · includes cache reads</Text>
            {value.profile ? <Text style={{ color: colors.ink3, fontSize: 11, lineHeight: 17 }}>Edit avatar and nickname in Profile on the desktop app.</Text> : null}
          </View>
        </>
      ) : <InlineError text={resource.error} />}
    </ScrollView>
  )
}
