import { Redirect } from 'expo-router'
/** Providers are configured on the computer; old links open the mobile model picker. */
export default function Providers() {
  return <Redirect href="/models" />
}
