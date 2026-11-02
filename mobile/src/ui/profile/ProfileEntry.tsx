import { useCallback } from 'react'
import { router } from 'expo-router'
import { useConnection } from '../../state/AppContext'
import { useFocusedResource } from '../../core/useFocusedResource'
import { loadPersonalProfile } from '../../core/profile'
import type { ApiClient } from '../../core/client'
import { Group, Icon, ListRow, useColors } from '../kit'
import { ProfileAvatar } from './ProfileAvatar'

export function ProfileEntry() {
  const { client } = useConnection()
  return <ConnectedEntry key={client?.host.id ?? 'none'} client={client} />
}

function ConnectedEntry({ client }: { client: ApiClient | null }) {
  const colors = useColors()
  const load = useCallback((signal: AbortSignal) => client ? loadPersonalProfile(client, signal) : Promise.resolve(null), [client])
  const { value } = useFocusedResource(load)
  return (
    <Group style={{ marginBottom: 16 }}>
      <ListRow
        title="个人主页"
        subtitle={value?.displayName || '个人资料、Token 用量与使用记录'}
        minHeight={72}
        leading={<ProfileAvatar profile={value} size={40} />}
        trailing={<Icon name="chevron-right" size={16} color={colors.chevron} />}
        onPress={() => router.push('/profile')}
      />
    </Group>
  )
}
