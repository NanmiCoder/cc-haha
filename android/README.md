# Claude Haha Android 客户端

这是 Claude Haha 项目的 Android 客户端，用于通过局域网远程连接到本地电脑上的 Claude Haha 服务器。

## 📱 功能特性

- 🔌 连接本地服务器进行 AI 对话
- 💬 实时聊天界面
- ⚙️ 可配置服务器地址
- 📡 WebSocket 实时通信

## 🚀 快速开始

### 前置条件

1. 安装 Node.js 和 Bun
2. 安装 Expo Go App（在 Android 手机上）
3. 确保手机和电脑在同一局域网

### 安装依赖

```bash
cd android
bun install
```

### 启动开发服务器

```bash
bun start
```

然后在手机上打开 Expo Go，扫描终端显示的二维码。

## ⚙️ 配置服务器

### 1. 在电脑上启动 Claude Haha 服务器

```bash
# 回到项目根目录
cd ..

# 启动服务器（绑定到所有网络接口）
SERVER_HOST=0.0.0.0 SERVER_PORT=3456 bun run src/server/index.ts
```

### 2. 获取电脑的 IP 地址

在 Windows 上：
```powershell
ipconfig
```

查找 "IPv4 地址"，例如：`192.168.1.100`

### 3. 在 App 中配置服务器

1. 打开 App
2. 点击 "服务器配置"
3. 输入服务器地址：`http://192.168.1.100:3456`（替换为你的实际 IP）
4. 点击 "测试连接"
5. 保存配置

## 🏗️ 项目结构

```
android/
├── src/
│   ├── api/              # API 客户端
│   │   ├── client.ts     # HTTP API
│   │   └── websocket.ts  # WebSocket
│   ├── components/       # React Native 组件
│   │   ├── chat/         # 聊天相关组件
│   │   └── shared/       # 通用组件
│   ├── screens/          # 页面
│   ├── stores/           # Zustand 状态管理
│   ├── types/            # TypeScript 类型
│   ├── hooks/            # 自定义 Hooks
│   └── constants/        # 常量
├── App.tsx               # 应用入口
├── app.json              # Expo 配置
└── package.json
```

## 📦 构建 APK

```bash
# 安装 EAS CLI
bun add -g eas-cli

# 登录 Expo
eas login

# 构建 APK
eas build --platform android --profile preview
```

## 🔧 常见问题

### 无法连接到服务器

1. 确认手机和电脑在同一 Wi-Fi
2. 检查 Windows 防火墙是否允许 3456 端口
3. 确认服务器已启动并绑定到 0.0.0.0
4. 尝试关闭电脑的 VPN

### 网络请求被拒绝

确保在 `app.json` 中已设置：
```json
"android": {
  "usesCleartextTraffic": true
}
```

## 📚 相关文档

- 项目主文档：`../MOBILE_CUSTOMIZATION_GUIDE.md`
- Expo 文档：https://docs.expo.dev/
