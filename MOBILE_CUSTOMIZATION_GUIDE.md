# Windows & Android 客户端定制指南

## 📋 概述

本指南说明如何基于现有项目定制 Windows 和 Android 客户端，实现远程对话功能。

---

## 💻 Windows 客户端（已有支持）

### 技术栈
- **Tauri 2.0** - 跨平台桌面框架
- **React 18** - UI 框架
- **Bun** - 运行时和构建工具

### 构建步骤

```powershell
# 1. 安装依赖
bun install
cd desktop
bun install

# 2. 构建 Windows x64 版本
bun run build:windows-x64
```

### 构建脚本位置
`desktop/scripts/build-windows-x64.ps1`

### 输出位置
`desktop/build-artifacts/windows-x64/`

---

## 📱 Android 客户端（需要新建）

### 推荐技术栈
- **React Native + Expo** - 跨平台移动框架
- **Zustand** - 状态管理（复用桌面端）
- **TypeScript** - 类型安全

### 目录结构设计

```
android/
├── src/
│   ├── api/                    # API 客户端（复用桌面端）
│   │   ├── client.ts          # 基础 API 客户端
│   │   ├── websocket.ts       # WebSocket 管理
│   │   ├── sessions.ts        # 会话 API
│   │   ├── agents.ts          # Agent API
│   │   └── models.ts          # 模型 API
│   ├── components/            # React Native 组件
│   │   ├── chat/
│   │   │   ├── MessageList.tsx
│   │   │   ├── ChatInput.tsx
│   │   │   ├── UserMessage.tsx
│   │   │   └── AssistantMessage.tsx
│   │   ├── shared/
│   │   │   ├── Button.tsx
│   │   │   ├── Input.tsx
│   │   │   └── Spinner.tsx
│   │   └── layout/
│   │       ├── AppShell.tsx
│   │       └── Sidebar.tsx
│   ├── screens/               # 页面
│   │   ├── HomeScreen.tsx
│   │   ├── ChatScreen.tsx
│   │   ├── SettingsScreen.tsx
│   │   └── ServerConfigScreen.tsx
│   ├── stores/                # Zustand 状态管理（复用）
│   │   ├── chatStore.ts
│   │   ├── sessionStore.ts
│   │   └── settingsStore.ts
│   ├── types/                 # 类型定义（复用）
│   │   ├── chat.ts
│   │   ├── session.ts
│   │   └── settings.ts
│   ├── hooks/                 # 自定义 Hooks
│   │   ├── useWebSocket.ts
│   │   └── useSession.ts
│   └── constants/
│       └── config.ts
├── app/
│   ├── (tabs)/
│   │   ├── index.tsx
│   │   ├── chat.tsx
│   │   └── settings.tsx
│   └── _layout.tsx
├── app.json
├── package.json
├── tsconfig.json
└── babel.config.js
```

---

## 🌐 本地服务器配置

### 启动服务器（支持远程访问）

```bash
# 在项目根目录
SERVER_HOST=0.0.0.0 SERVER_PORT=3456 bun run src/server/index.ts
```

### 环境变量说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SERVER_HOST` | 服务器绑定地址 | `127.0.0.1` |
| `SERVER_PORT` | 服务器端口 | `3456` |
| `SERVER_AUTH_REQUIRED` | 是否强制认证 | `0` |

### 安全机制
- 绑定到 `0.0.0.0` 时**自动启用认证**
- 认证中间件：`src/server/middleware/auth.ts`
- CORS 已配置：`src/server/middleware/cors.ts`

### 获取本地 IP 地址（Windows）

```powershell
ipconfig
# 查找 "IPv4 地址"，例如：192.168.1.100
```

---

## 🏗️ 核心代码示例

### 1. API 客户端（复用桌面端）

```typescript
// android/src/api/client.ts
const DEFAULT_BASE_URL = 'http://192.168.1.100:3456'  // 修改为你的电脑 IP

let baseUrl = DEFAULT_BASE_URL

export function setBaseUrl(url: string) {
  baseUrl = url.replace(/\/$/, '')
}

export function getBaseUrl() {
  return baseUrl
}

export const api = {
  get: <T>(path: string) => fetch(`${baseUrl}${path}`).then(r => r.json()),
  post: <T>(path: string, body?: unknown) => 
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(r => r.json()),
}
```

### 2. WebSocket 管理器（复用桌面端）

```typescript
// android/src/api/websocket.ts
import { getBaseUrl } from './client'

class WebSocketManager {
  private ws: WebSocket | null = null
  
  connect(sessionId: string) {
    const wsUrl = getBaseUrl().replace(/^http/, 'ws')
    this.ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
    
    this.ws.onopen = () => console.log('WebSocket connected')
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      // 处理消息
    }
    this.ws.onclose = () => console.log('WebSocket closed')
  }
  
  send(message: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }
  
  disconnect() {
    this.ws?.close()
  }
}

export const wsManager = new WebSocketManager()
```

### 3. 服务器配置页面

```typescript
// android/src/screens/ServerConfigScreen.tsx
import React, { useState } from 'react'
import { View, TextInput, Button, StyleSheet } from 'react-native'
import { setBaseUrl } from '../api/client'

export default function ServerConfigScreen() {
  const [url, setUrl] = useState('http://192.168.1.100:3456')
  
  const handleSave = () => {
    setBaseUrl(url)
    // 保存到 AsyncStorage
  }
  
  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        placeholder="服务器地址"
      />
      <Button title="保存" onPress={handleSave} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { padding: 20 },
  input: { borderWidth: 1, padding: 10, marginBottom: 10 },
})
```

---

## 🚀 完整实施步骤

### 阶段 1：项目初始化

1. **创建 Expo 项目**
   ```bash
   npx create-expo-app@latest android --template blank-typescript
   cd android
   ```

2. **安装依赖**
   ```bash
   bun add zustand @react-native-async-storage/async-storage
   ```

### 阶段 2：复用桌面端代码

1. 复制 `desktop/src/api/` → `android/src/api/`
2. 复制 `desktop/src/types/` → `android/src/types/`
3. 复制 `desktop/src/stores/` → `android/src/stores/`
4. 调整代码以适配 React Native

### 阶段 3：实现核心功能

1. 服务器配置页面
2. 会话列表页面
3. 聊天界面
4. WebSocket 实时通信

### 阶段 4：测试与打包

1. 在 Android 模拟器/真机上测试
2. 配置网络权限
3. 生成 APK

---

## 🔧 网络配置（重要）

### Android 网络权限
在 `android/app/src/main/AndroidManifest.xml` 中添加：

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

### 允许明文流量（开发环境）
在 `android/app/src/main/AndroidManifest.xml` 的 `<application>` 标签中添加：

```xml
android:usesCleartextTraffic="true"
```

---

## 📱 Android 构建命令

```bash
# 开发模式
bun expo start

# 构建 APK
bun expo build:android
```

---

## 🎯 完整架构图

```
┌─────────────────┐         HTTP/WebSocket          ┌─────────────────────┐
│   Android  App  │ ◄─────────────────────────────► │   本地电脑服务器     │
│  (React Native) │                                 │   (Bun + Tauri)      │
└─────────────────┘                                 └─────────────────────┘
         │                                                    │
         │                                                    ├─ 对话引擎
         │                                                    ├─ Agent 管理
         │                                                    └─ 模型接入
         │
         ▼
┌─────────────────┐
│  聊天界面       │
│  会话管理       │
│  服务器配置     │
└─────────────────┘
```

---

## 📚 参考文件

| 文件 | 说明 |
|------|------|
| `desktop/src/api/client.ts` | API 客户端基础 |
| `desktop/src/api/websocket.ts` | WebSocket 管理 |
| `src/server/index.ts` | 服务器入口 |
| `desktop/src/stores/` | Zustand 状态管理 |
| `desktop/src/components/chat/` | 聊天组件参考 |

---

## ⚠️ 注意事项

1. **网络安全**：生产环境应使用 HTTPS/WSS
2. **认证**：远程访问时服务器会要求认证
3. **防火墙**：确保 Windows 防火墙允许 3456 端口入站
4. **IP 地址**：手机和电脑需在同一局域网，或使用内网穿透

---

## 🎉 下一步

1. 确认本地服务器可以正常启动
2. 测试 Windows 客户端构建
3. 初始化 Android 项目
4. 实现服务器配置功能
5. 实现聊天功能
