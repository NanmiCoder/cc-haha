import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  migratePreferences,
  PreferencesRepository,
  type Preferences,
  type PreferencesPatch,
} from './preferences'

const repository = new PreferencesRepository(AsyncStorage)
const Context = createContext<{
  preferences: Preferences
  ready: boolean
  error: string
  update(patch: PreferencesPatch): Promise<void>
} | null>(null)
export function PreferencesProvider({ children }: PropsWithChildren) {
  const [preferences, setPreferences] = useState(() => migratePreferences(null))
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    repository
      .load()
      .then((value) => {
        setPreferences(value)
        setReady(true)
      })
      .catch((e) => setError(e.message))
  }, [])
  return (
    <Context.Provider
      value={{
        preferences,
        ready,
        error,
        update: async (patch) => {
          if (!ready || error) throw new Error(error || '手机设置尚未读取完成')
          setPreferences(await repository.update(patch))
        },
      }}
    >
      {children}
    </Context.Provider>
  )
}
export function usePreferences() {
  const value = useContext(Context)
  if (!value) throw new Error('PreferencesProvider is missing')
  return value
}
