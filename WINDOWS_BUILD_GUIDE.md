# Windows 客户端构建指南

本指南说明如何构建和定制 Claude Haha 的 Windows 桌面客户端。

## 📋 前置条件

- Windows 10/11
- [Bun](https://bun.sh) 安装完成
- [Rust](https://www.rust-lang.org/tools/install) 安装完成（Tauri 需要）
- Visual Studio Build Tools（包含 C++ 开发工具）

## 🚀 快速开始

### 1. 安装依赖

```powershell
# 根目录依赖
bun install

# 桌面端依赖
cd desktop
bun install
```

### 2. 开发模式运行

```powershell
cd desktop
bun run dev
```

这会启动：
- Vite 开发服务器（前端）
- Tauri 开发窗口（桌面应用）

### 3. 构建生产版本

```powershell
cd desktop
bun run build:windows-x64
```

构建输出位于：`desktop/build-artifacts/windows-x64/`

## 🏗️ 项目结构

```
desktop/
├── src/                 # React 前端代码
│   ├── api/            # API 客户端
│   ├── components/     # React 组件
│   ├── screens/        # 页面
│   ├── stores/         # Zustand 状态管理
│   └── App.tsx         # 主应用
├── src-tauri/          # Rust 后端
│   ├── src/
│   │   └── main.rs     # Tauri 入口
│   └── Cargo.toml      # Rust 依赖
└── package.json
```

## 🎨 自定义配置

### 修改应用信息

编辑 `desktop/src-tauri/Cargo.toml`：

```toml
[package]
name = "claude-code-desktop"
version = "0.2.2"
description = "Claude Haha Desktop"
authors = ["Your Name"]
```

### 修改窗口配置

编辑 `desktop/src-tauri/tauri.conf.json`：

```json
{
  "tauri": {
    "windows": [
      {
        "title": "Claude Haha",
        "width": 1200,
        "height": 800,
        "resizable": true
      }
    ]
  }
}
```

## 🔧 自定义功能

### 添加新的 API 调用

1. 在 `desktop/src/api/` 中创建新文件
2. 复用 `client.ts` 中的基础 API 客户端
3. 在组件中调用

### 添加新组件

1. 在 `desktop/src/components/` 创建组件
2. 遵循现有组件的代码风格
3. 使用 TypeScript 类型

## 📦 发布构建

### 使用 GitHub Actions（推荐）

项目已配置 GitHub Actions 工作流：
- `.github/workflows/release-desktop.yml`

推送带有 `v*` 标签的提交会自动触发构建：

```powershell
git tag -a v0.3.0 -m "Release v0.3.0"
git push origin v0.3.0
```

### 手动构建

```powershell
cd desktop/src-tauri
cargo build --release
```

## 🐛 调试

### 查看开发工具

在 Tauri 窗口中按 `Ctrl+Shift+I` 打开开发者工具。

### 查看 Rust 日志

```powershell
cd desktop
bun run tauri dev -- --verbose
```

## 📚 相关文档

- [Tauri 文档](https://tauri.app/)
- [React 文档](https://react.dev/)
- 主项目文档：`README.md`
