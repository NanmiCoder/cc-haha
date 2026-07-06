
import React from 'react'
import { View, Text, StyleSheet, SafeAreaView, ScrollView } from 'react-native'
import Button from '../components/shared/Button'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

type RootStackParamList = {
  Home: undefined
  SessionList: undefined
  Chat: undefined
  ServerConfig: undefined
}

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Home'>

export default function HomeScreen() {
  const navigation = useNavigation<NavigationProp>()

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.content}>
        <Text style={styles.title}>Claude Haha</Text>
        <Text style={styles.subtitle}>Remote AI Assistant</Text>
        
        <View style={styles.buttonContainer}>
          <Button
            title="View Sessions"
            onPress={() => navigation.navigate('SessionList')}
            style={styles.primaryButton}
          />
          <Button
            title="New Chat"
            onPress={() => navigation.navigate('SessionList')}
            style={styles.secondaryButton}
          />
          <Button
            title="Server Configuration"
            onPress={() => navigation.navigate('ServerConfig')}
            style={styles.tertiaryButton}
          />
        </View>

        <View style={styles.infoContainer}>
          <Text style={styles.infoTitle}>How It Works</Text>
          <Text style={styles.infoText}>
            1. Ensure your phone and computer are on the same Wi-Fi network
          </Text>
          <Text style={styles.infoText}>
            2. Start the Claude Haha server on your computer
          </Text>
          <Text style={styles.infoText}>
            3. Configure the server URL and test the connection
          </Text>
          <Text style={styles.infoText}>
            4. Start chatting! Your sessions sync across devices
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    padding: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    textAlign: 'center',
    marginTop: 40,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 18,
    color: '#666',
    textAlign: 'center',
    marginBottom: 40,
  },
  buttonContainer: {
    gap: 16,
    marginBottom: 40,
  },
  primaryButton: {
    backgroundColor: '#007AFF',
  },
  secondaryButton: {
    backgroundColor: '#34C759',
  },
  tertiaryButton: {
    backgroundColor: '#8E8E93',
  },
  infoContainer: {
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    padding: 20,
  },
  infoTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  infoText: {
    fontSize: 15,
    color: '#333',
    marginBottom: 8,
    lineHeight: 22,
  },
})
