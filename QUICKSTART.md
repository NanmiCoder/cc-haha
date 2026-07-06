# Claude Haha 定制快速开始

恭喜！你现在可以定制 Windows 和 Android 客户端了！

## 📁 已创建的文件

### 📱 Android 客户端 (`android/`)
- `package.json` - 项目依赖配置
- `App.tsx` - 应用入口
- `src/api/client.ts` - API 客户端（复用桌面端代码）
- `src/api/websocket.ts` - WebSocket 管理器（复用桌面端代码）
- `src/screens/HomeScreen.tsx` - 首页
- `src/screens/ChatScreen.tsx` - 聊天页
- `src/screens/ServerConfigScreen.tsx` - 服务器配置页
- `src/components/chat/*` - 聊天组件
- `src/stores/chatStore.ts` - 状态管理
- `README.md` - Android 项目文档

### 🖥️ Windows 客户端
- `WINDOWS_BUILD_GUIDE.md` - Windows 构建指南
- `desktop/scripts/build-windows-x64.ps1` - 已有构建脚本

### 🌐 服务器
- `start-server.bat` - Windows 一键启动脚本（支持远程连接）

### 📚 文档
- `MOBILE_CUSTOMIZATION_GUIDE.md` - 完整定制指南
- `WINDOWS_BUILD_GUIDE.md` - Windows 构建指南
- `android/README.md` - Android 项目说明

---

## 🚀 快速体验

### 1️⃣ 启动本地服务器（支持 Android 连接）

**Windows 用户：**
```powershell
# 双击运行或在命令行执行
start-server.bat
```

**或手动运行：**
```powershell
$env:SERVER_HOST="0.0.0.0"
$env:SERVER_PORT="3456"
bun run src/server/index.ts
```

### 2️⃣ 构建/运行 Windows 客户端

```powershell
cd desktop
bun install
bun run dev
```

### 3️⃣ 运行 Android 客户端

```powershell
cd android
bun install
bun start
```

然后在手机上安装 Expo Go，扫描二维码。

---

## 🎯 下一步做什么？

1. **完善 Android 客户端**
   - 实现真正的会话 API 调用
   - 添加消息历史
   - 完善 UI/UX

2. **自定义 Windows 客户端**
   - 修改主题颜色
   - 添加品牌标识
   - 自定义功能

3. **部署服务器**
   - 使用内网穿透工具（如 ngrok）实现外网访问
   - 配置 HTTPS

---

## 📚 详细文档

- **完整定制指南**: [MOBILE_CUSTOMIZATION_GUIDE.md](./MOBILE_CUSTOMIZATION_GUIDE.md)
- **Windows 构建**: [WINDOWS_BUILD_GUIDE.md](./WINDOWS_BUILD_GUIDE.md)
- **Android 项目**: [android/README.md](./android/README.md)

祝你定制愉快！🎉
