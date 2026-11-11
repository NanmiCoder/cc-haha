import { requireOptionalNativeModule } from 'expo'
import type { RemoteIdentityKeys } from '../core/remoteIdentity'

// Optional on iOS/web/Expo Go: existing LAN and ordinary bearer pairing stay usable.
export const remoteIdentityKeys = requireOptionalNativeModule<RemoteIdentityKeys & {
  addListener(event: 'networkChanged', listener: () => void): { remove(): void }
}>('RemoteIdentity')
