# Workspaces

此目录由 web target（`bun run start:web`）在创建会话时自动 mkdir
`workspaces/<sessionId>/` 作为该会话的 cwd。

约定：
- 子目录由 server 自动创建，**永不自动清理**。
- 已被 `.gitignore` 忽略，不进版本控制。
- 删除会话不会清理 workspace（保留磁盘上的文件用于审计）。
- 仅 web 模式启用；desktop 模式仍以用户选择的目录为 cwd。
