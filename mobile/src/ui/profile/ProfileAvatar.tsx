import { useState } from 'react'
import { Image, View } from 'react-native'
import type { PersonalProfile } from '../../core/profile'
import { Icon, useColors } from '../kit'
import { Text } from '../Text'

/** Uploaded identity is shared with the settings entry; no app logo masquerades as an avatar. */
export function ProfileAvatar({ profile, size = 64 }: { profile: PersonalProfile | null; size?: number }) {
  const colors = useColors()
  const [failed, setFailed] = useState<string | null>(null)
  const avatar = profile?.avatarDataUrl
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: colors.hair, padding: 3, flexShrink: 0 }}>
      <View style={{ flex: 1, borderRadius: size / 2, overflow: 'hidden', backgroundColor: colors.fill, alignItems: 'center', justifyContent: 'center' }}>
        {avatar && failed !== avatar ? (
          <Image source={{ uri: avatar }} accessibilityLabel={`${profile?.displayName}的头像`} resizeMode="cover" style={{ width: '100%', height: '100%' }} onError={() => setFailed(avatar)} />
        ) : profile?.displayName ? (
          <Text accessibilityLabel="未设置头像" style={{ color: colors.ink2, fontSize: size * 0.35, fontWeight: '500' }}>{Array.from(profile.displayName)[0]}</Text>
        ) : <Icon name="users" size={size * 0.4} color={colors.faint} />}
      </View>
    </View>
  )
}
