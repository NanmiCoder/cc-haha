// 正體中文 catalog — 繁體中文翻譯。

export const zhTW: Record<string, string> = {
  'secure_storage_plaintext_warning':
    '警告：憑證以明文形式儲存。',
  'secure_storage_libsecret_warning':
    '憑證透過 libsecret 儲存於系統金鑰圈。',
  'secure_storage_libsecret_hint':
    '請安裝 libsecret-tools（Debian/Ubuntu）或 libsecret（Fedora/Arch）以使用系統金鑰圈。',
  'bash_security_parse_failed':
    'Bash 命令解析失敗；已回退至啟發式驗證。',

  'provider_connectivity_error':
    '供應商連線錯誤：%{detail}',
  'provider_local_model_hint':
    '偵測到本機模型 %{baseUrl} — 請先啟動伺服器再連線。',
  'provider_local_model_started':
    '本機模型連線成功，耗時 %{latencyMs}ms。',
  'provider_missing_baseurl_or_apikey':
    '缺少 baseUrl 或 apiKey — 請先設定供應商。',
  'provider_test_timeout':
    '請求逾時（%{seconds}s）— 上游伺服器回應可能過慢。',
  'provider_upstream_error':
    '上游錯誤 %{status}：%{detail}',
  'provider_model_capabilities_unknown':
    '無法判定模型 %{model} 的能力，將使用預設值。',

  'fs_symlink_unsafe':
    '路徑不安全 — 目標不在允許目錄內。',
  'fs_symlink_absolute_required':
    '路徑必須是絕對路徑。',

  'fs_warning_crossing':
    '路徑穿越警告 — 路徑中的符號連結指向工作目錄之外。',
  'fs_normalized_path':
    '路徑已從工作目錄外的符號連結進行正規化。',

  'cli_security_notice_header':
    '— 安全提醒：cc-haha —',
  'cli_version':
    'Claude Code（cc-haha）v%{version}',
}
