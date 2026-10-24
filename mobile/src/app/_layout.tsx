import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useFonts } from 'expo-font'
import { AppProvider } from '../state/AppContext'
import { LiveActivityBridge } from '../widgets/LiveActivityBridge'
import { PushRegistrationProvider } from '../state/PushRegistrationContext'
import { NotificationBridge } from '../state/NotificationBridge'
import { DashboardProvider } from '../state/DashboardContext'
import { PreferencesProvider } from '../state/PreferencesContext'
import { useTheme } from '../ui/theme'
import { Platform, View } from 'react-native'
import { Text } from '../ui/Text'
import Constants, { ExecutionEnvironment } from 'expo-constants'

function Navigation() {
  const { colors, dark } = useTheme()
  const [loaded, error] = useFonts({
    Geist: require('../../assets/fonts/Geist.ttf'),
    GeistMono: require('../../assets/fonts/GeistMono.ttf'),
  })
  if (!loaded && !error)
    return <View style={{ flex: 1, backgroundColor: colors.paper }} />
  if (
    Platform.OS === 'android' &&
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient
  )
    return (
      <View
        style={{
          flex: 1,
          padding: 30,
          justifyContent: 'center',
          gap: 16,
          backgroundColor: colors.paper,
        }}
      >
        <Text style={{ color: colors.ink, fontSize: 22 }}>
          请安装 cc-haha 原生 App
        </Text>
        <Text style={{ color: colors.muted, lineHeight: 24 }}>
          请使用项目生成的开发版或安装包，以启用原生连接保护。
        </Text>
      </View>
    )
  return (
    <>
      <NotificationBridge />
      <LiveActivityBridge />
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.paper },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="connect" options={{ presentation: 'modal' }} />
        <Stack.Screen
          name="new"
          options={{
            presentation: 'transparentModal',
            contentStyle: { backgroundColor: 'transparent' },
          }}
        />
      </Stack>
    </>
  )
}
export default function Layout() {
  return (
    <PreferencesProvider>
      <AppProvider>
        <PushRegistrationProvider>
          <DashboardProvider>
            <Navigation />
          </DashboardProvider>
        </PushRegistrationProvider>
      </AppProvider>
    </PreferencesProvider>
  )
}
