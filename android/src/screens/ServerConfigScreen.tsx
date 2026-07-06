import React, { useState, useEffect } from 'react'
import { View, Text, TextInput, StyleSheet, SafeAreaView, Alert, TouchableOpacity, Switch, ScrollView } from 'react-native'
import Button from '../components/shared/Button'
import { setBaseUrl, getBaseUrl, setAccessToken, getAccessToken, testConnection } from '../api/client'
import { useNavigation } from '@react-navigation/native'

export default function ServerConfigScreen() {
  const [serverUrl, setServerUrlInput] = useState('')
  const [accessToken, setAccessTokenInput] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'success' | 'failed'>('unknown')
  const navigation = useNavigation()

  useEffect(() => {
    // 加载已保存的配置
    setServerUrlInput(getBaseUrl())
    setAccessTokenInput(getAccessToken())
  }, [])

  const handleTestConnection = async () => {
    if (!serverUrl.trim()) {
      Alert.alert('Error', 'Please enter a server URL')
      return
    }

    setIsLoading(true)
    setConnectionStatus('unknown')

    try {
      // 临时设置 URL 和 token 进行测试
      const originalUrl = getBaseUrl()
      const originalToken = getAccessToken()
      setBaseUrl(serverUrl.trim())
      await setAccessToken(accessToken.trim())
      
      // 测试连接
      const success = await testConnection()
      
      if (success) {
        setConnectionStatus('success')
        Alert.alert('Success', 'Connection successful!')
      } else {
        setConnectionStatus('failed')
        setBaseUrl(originalUrl)
        await setAccessToken(originalToken)
        Alert.alert('Error', 'Connection failed. Please check the URL and access token.')
      }
    } catch (error) {
      setConnectionStatus('failed')
      Alert.alert('Error', 'Connection failed: ' + (error as Error).message)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async () => {
    if (!serverUrl.trim()) {
      Alert.alert('Error', 'Please enter a server URL')
      return
    }

    try {
      setBaseUrl(serverUrl.trim())
      await setAccessToken(accessToken.trim())
      Alert.alert('Success', 'Configuration saved!', [
        { text: 'OK', onPress: () => navigation.goBack() }
      ])
    } catch (error) {
      Alert.alert('Error', 'Failed to save configuration')
    }
  }

  const getStatusText = () => {
    switch (connectionStatus) {
      case 'success':
        return 'Connected ✓'
      case 'failed':
        return 'Connection Failed ✗'
      default:
        return 'Not Tested'
    }
  }

  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'success':
        return '#34C759'
      case 'failed':
        return '#FF3B30'
      default:
        return '#8E8E93'
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.scrollView}>
        <Text style={styles.title}>Server Configuration</Text>
        <Text style={styles.subtitle}>
          Configure your Claude Code API server connection
        </Text>

        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>Server URL</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrlInput}
              placeholder="http://172.21.96.1:3456"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Text style={styles.hint}>
              Enter your server URL including port (e.g. http://your-ip:3456)
            </Text>
          </View>

          <View style={styles.field}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>Access Token (Optional)</Text>
              <Switch
                value={showToken}
                onValueChange={setShowToken}
                trackColor={{ false: '#ddd', true: '#007AFF30' }}
                thumbColor={showToken ? '#007AFF' : '#fff'}
              />
            </View>
            <TextInput
              style={styles.input}
              value={accessToken}
              onChangeText={setAccessTokenInput}
              placeholder="Enter your access token"
              secureTextEntry={!showToken}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.hint}>
              Required for public/network access. Configure SERVER_ACCESS_TOKEN on your server.
            </Text>
          </View>

          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Status: </Text>
            <Text style={[styles.statusText, { color: getStatusColor() }]}>
              {getStatusText()}
            </Text>
          </View>

          <View style={styles.buttonGroup}>
            <Button
              title="Test Connection"
              onPress={handleTestConnection}
              disabled={isLoading}
              style={styles.testButton}
            />
            <Button
              title="Save Configuration"
              onPress={handleSave}
              style={styles.saveButton}
            />
          </View>
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.infoTitle}>Quick Setup Guide</Text>
          <Text style={styles.infoText}>
            1. Start your Claude Code server on your computer
          </Text>
          <Text style={styles.infoText}>
            2. Set SERVER_HOST=0.0.0.0 for network access
          </Text>
          <Text style={styles.infoText}>
            3. Find your computer's local IP address
          </Text>
          <Text style={styles.infoText}>
            4. Enter http://[YOUR IP]:3456 here
          </Text>
          <Text style={styles.infoText}>
            5. Set SERVER_ACCESS_TOKEN for security
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
  scrollView: {
    flex: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    textAlign: 'center',
    marginTop: 40,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 40,
    paddingHorizontal: 20,
  },
  form: {
    paddingHorizontal: 20,
  },
  field: {
    marginBottom: 24,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
    color: '#333',
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    backgroundColor: '#f8f8f8',
  },
  hint: {
    fontSize: 14,
    color: '#666',
    marginTop: 8,
    lineHeight: 20,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
  },
  statusLabel: {
    fontSize: 16,
    color: '#333',
  },
  statusText: {
    fontSize: 16,
    fontWeight: '600',
  },
  buttonGroup: {
    gap: 12,
    marginBottom: 30,
  },
  testButton: {
    backgroundColor: '#8E8E93',
  },
  saveButton: {
    backgroundColor: '#007AFF',
  },
  infoBox: {
    margin: 20,
    padding: 20,
    backgroundColor: '#f0f8ff',
    borderRadius: 12,
  },
  infoTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
    color: '#007AFF',
  },
  infoText: {
    fontSize: 15,
    color: '#333',
    marginBottom: 10,
    lineHeight: 22,
  },
})
