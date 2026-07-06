# Claude Code 公网/网络访问部署指南

本指南详细介绍如何将 Claude Code 服务器配置为支持局域网或公网访问，并通过 Android 等设备进行远程对话。

## 目录

1. [快速开始](#快速开始)
2. [局域网部署](#局域网部署)
3. [公网部署](#公网部署)
4. [安全配置](#安全配置)
5. [故障排除](#故障排除)

---

## 快速开始

### 1. 环境配置

在 `.env` 文件中配置：

```env
# 服务器绑定地址（0.0.0.0 表示监听所有网络接口）
SERVER_HOST=0.0.0.0

# 服务器端口
SERVER_PORT=3456

# 访问令牌（用于公网/网络访问认证）
SERVER_ACCESS_TOKEN=your_secure_token_here
```

### 2. 启动服务器

Windows 用户可以使用 `start-server.bat`，或手动：

```powershell
$env:SERVER_HOST="0.0.0.0"
$env:SERVER_ACCESS_TOKEN="your_secure_token_here"
bun run src/server/index.ts
```

### 3. 配置 Android 设备

1. 在手机上打开 Claude Haha 应用
2. 进入"Server Configuration"
3. 输入服务器地址：`http://YOUR_IP:3456`
4. 输入访问令牌（如果配置了）
5. 点击"Test Connection"测试
6. 保存配置

---

## 局域网部署

局域网部署是最简单的场景，适合在家中或办公室使用。

### 步骤

#### 1. 获取本地 IP 地址

**Windows:**
```powershell
ipconfig
# 查找 "IPv4 Address"，例如：192.168.1.100
```

**macOS/Linux:**
```bash
ifconfig
# 或
ip addr show
```

#### 2. 配置防火墙

允许端口 3456 入站连接：

**Windows Firewall:**
```powershell
# 以管理员身份运行
New-NetFirewallRule -DisplayName "Claude Code Server" -Direction Inbound -Protocol TCP -LocalPort 3456 -Action Allow
```

**macOS:**
1. 打开"系统设置" > "网络"
2. 点击"防火墙"
3. 添加规则允许传入连接

#### 3. 验证连接

从另一台设备（或手机）：

```bash
# 测试端口是否开放
telnet YOUR_IP 3456
# 或
curl http://YOUR_IP:3456/api/sessions -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 公网部署

公网部署允许从任何地方访问服务器，有几种常用方案：

### 方案 A：路由器端口转发（推荐用于家庭网络）

#### 步骤

1. **登录路由器管理界面**
   - 通常是 http://192.168.1.1 或 http://192.168.0.1

2. **配置端口转发**
   - 外部端口：3456
   - 内部 IP：你的电脑本地 IP（如 192.168.1.100）
   - 内部端口：3456
   - 协议：TCP

3. **获取公网 IP**
   ```bash
   # Windows PowerShell
   (Invoke-WebRequest ifconfig.me).Content
   
   # Linux/macOS
   curl ifconfig.me
   ```

4. **Android 配置**
   - 服务器地址：`http://YOUR_PUBLIC_IP:3456`
   - 访问令牌：配置的 SERVER_ACCESS_TOKEN

#### 安全提示

⚠️ **重要：公网部署必须设置访问令牌！**

### 方案 B：ngrok（临时公网访问，最简便）

适合临时使用或测试：

1. **安装 ngrok**
   - 下载：https://ngrok.com/download

2. **启动服务**
   ```bash
   # 先启动 Claude Code 服务器
   # 然后
   ngrok http 3456
   ```

3. **获取公网地址**
   - ngrok 会显示类似：`https://abc123.ngrok.io`

4. **Android 配置**
   - 使用 ngrok 提供的 HTTPS 地址
   - 访问令牌仍然需要

### 方案 C：云服务器（稳定生产方案）

如果需要 24/7 稳定访问：

1. **购买云服务器**
   - 推荐：阿里云、腾讯云、AWS、DigitalOcean
   - 配置：1核1GB 即可

2. **部署环境**
   ```bash
   # 服务器上安装 Node.js/Bun
   # 克隆项目
   git clone YOUR_REPO
   
   # 配置 .env
   SERVER_HOST=0.0.0.0
   SERVER_PORT=3456
   SERVER_ACCESS_TOKEN=your_secure_token
   
   # 启动服务
   bun run src/server/index.ts
   ```

3. **配置 Nginx（可选但推荐）**
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://127.0.0.1:3456;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
       }
   }
   ```

4. **设置 HTTPS（强烈推荐）**
   - 使用 Let's Encrypt 免费证书
   - 使用 certbot：`certbot --nginx`

---

## 安全配置

### 1. 访问令牌生成

生成安全的访问令牌：

```bash
# 生成随机令牌（Linux/macOS）
openssl rand -base64 32

# Windows PowerShell
[System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

### 2. 安全最佳实践

✅ **必须做：**
- 设置强访问令牌
- 公网部署使用 HTTPS
- 定期轮换访问令牌
- 限制 IP 访问（如果可能）

❌ **不要做：**
- 在公网部署时不设置访问令牌
- 使用 ANTHROPIC_API_KEY 作为访问令牌（建议使用独立的 SERVER_ACCESS_TOKEN）
- 将 .env 文件提交到版本控制
- 在公开场合分享访问令牌

### 3. 环境变量说明

| 变量 | 说明 | 推荐值 |
|------|------|--------|
| SERVER_HOST | 绑定地址 | 0.0.0.0 |
| SERVER_PORT | 端口 | 3456 |
| SERVER_ACCESS_TOKEN | 访问令牌 | 随机生成的强密码 |
| ANTHROPIC_API_KEY | Anthropic API 密钥 | 你的 API 密钥 |

---

## 故障排除

### 常见问题

#### Q: 无法连接到服务器

**检查清单：**
1. 服务器是否正在运行？
2. 防火墙是否允许端口访问？
3. IP 地址是否正确？
4. 是否在同一网络（局域网）？
5. 访问令牌是否正确？

#### Q: WebSocket 连接失败

**解决方案：**
1. 确保服务器支持 WebSocket 升级（已内置）
2. 检查是否有防火墙或代理阻止 WebSocket
3. 验证访问令牌配置

#### Q: 认证失败

**常见原因：**
1. 忘记设置访问令牌
2. 令牌在 Android 和服务器上不匹配
3. 令牌包含特殊字符（URL 编码问题）

**调试步骤：**
1. 查看服务器日志
2. 使用 curl 测试 API
3. 检查网络请求（开发者工具）

### 调试命令

```bash
# 测试 API 连接
curl -v http://YOUR_IP:3456/api/sessions \
  -H "Authorization: Bearer YOUR_TOKEN"

# 检查端口监听
netstat -ano | findstr 3456  # Windows
netstat -tuln | grep 3456     # Linux/macOS

# 查看服务器日志
# 观察启动日志和请求日志
```

---

## 下一步

- 了解如何[跨设备同步会话](./跨端会话同步方案总结.md)
- 查看 [Windows 构建指南](./WINDOWS_BUILD_GUIDE.md)
- 探索 [Android 客户端配置](./android/README.md)

---

## 支持

如有问题，请：
1. 查看项目 README
2. 检查服务器日志
3. 提交 Issue 或 Pull Request
