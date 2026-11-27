import { Redirect, useLocalSearchParams } from 'expo-router'
/** Providers and local runtimes (including Antigravity) live on the mobile models screen. */
export default function Providers() {
  const { host } = useLocalSearchParams<{ host?: string }>()
  return (
    <Redirect
      href={host ? { pathname: '/models', params: { host } } : '/models'}
    />
  )
}
