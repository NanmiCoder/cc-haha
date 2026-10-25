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

// web 预览：输入框的聚焦反馈由设计自己画（光标、描边），去掉浏览器默认的蓝色外框。
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const style = document.createElement('style')
  style.textContent = 'input:focus, textarea:focus { outline: none; }'
  document.head.appendChild(style)
}

function Navigation() {
  const { colors, dark } = useTheme()
  const [loaded, error] = useFonts({
    GeistMono: require('../../assets/fonts/GeistMono.ttf'),
  })
  if (!loaded && !error)
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />
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
          backgroundColor: colors.bg,
        }}
      >
        <Text style={{ color: colors.ink, fontSize: 22 }}>
          请安装 cc-haha 原生 App
        </Text>
        <Text style={{ color: colors.ink3, lineHeight: 24 }}>
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
          contentStyle: { backgroundColor: colors.bg },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen
          name="connect"
          options={{
            presentation: 'fullScreenModal',
            contentStyle: { backgroundColor: '#121110' },
          }}
        />
        <Stack.Screen name="new" options={{ presentation: 'modal' }} />
        <Stack.Screen
          name="files"
          options={{
            presentation: 'transparentModal',
            animation: 'none',
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
