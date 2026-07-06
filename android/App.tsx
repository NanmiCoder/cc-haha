
import React, { useEffect } from 'react'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { initBaseUrl } from './src/api/client'
import HomeScreen from './src/screens/HomeScreen'
import ChatScreen from './src/screens/ChatScreen'
import SessionListScreen from './src/screens/SessionListScreen'
import ServerConfigScreen from './src/screens/ServerConfigScreen'

const Stack = createNativeStackNavigator()

export default function App() {
  useEffect(() => {
    initBaseUrl()
  }, [])

  return (
    <NavigationContainer>
      <Stack.Navigator 
        initialRouteName="Home"
        screenOptions={{
          headerShown: false,
        }}
      >
        <Stack.Screen 
          name="Home" 
          component={HomeScreen}
        />
        <Stack.Screen 
          name="SessionList" 
          component={SessionListScreen}
        />
        <Stack.Screen 
          name="Chat" 
          component={ChatScreen}
        />
        <Stack.Screen 
          name="ServerConfig" 
          component={ServerConfigScreen}
        />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
