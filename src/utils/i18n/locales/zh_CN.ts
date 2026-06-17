// 简体中文 catalog.

export const zhCN: Record<string, string> = {
  'secure_storage_plaintext_warning':
    '警告：凭据以明文形式存储。',
  'secure_storage_libsecret_warning':
    '凭据通过 libsecret 存储在系统密钥环中。',
  'secure_storage_libsecret_hint':
    '请安装 libsecret-tools（Debian/Ubuntu）或 libsecret（Fedora/Arch）以使用系统密钥环。',
  'bash_security_parse_failed':
    'Bash 命令解析失败；已回退至启发式校验。',

  'provider_connectivity_error':
    '提供商连接错误：%{detail}',
  'provider_local_model_hint':
    '检测到本地模型 %{baseUrl} — 请先启动服务器再连接。',
  'provider_local_model_started':
    '本地模型连接成功，耗时 %{latencyMs}ms。',
  'provider_missing_baseurl_or_apikey':
    '缺少 baseUrl 或 apiKey — 请先配置提供商。',
  'provider_test_timeout':
    '请求超时（%{seconds}s）— 上游服务器响应可能过慢。',
  'provider_upstream_error':
    '上游错误 %{status}：%{detail}',
  'provider_model_capabilities_unknown':
    '无法确定模型 %{model} 的能力，将使用默认值。',

  'fs_symlink_unsafe':
    '路径不安全 — 目标不在允许目录内。',
  'fs_symlink_absolute_required':
    '路径必须是绝对路径。',

  'fs_warning_crossing':
    '路径穿越警告 — 路径中的符号链接指向工作目录之外。',
  'fs_normalized_path':
    '路径已从工作目录外的符号链接进行归一化。',

  'cli_security_notice_header':
    '— 安全提醒：cc-haha —',
  'cli_version':
    'Claude Code（cc-haha）v%{version}',
}
