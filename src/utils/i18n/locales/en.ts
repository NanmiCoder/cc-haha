// English catalog — the canonical key set.
// Other locale files provide translations for the same keys.

export const en: Record<string, string> = {
  'secure_storage_plaintext_warning':
    'Warning: Storing credentials in plaintext.',
  'secure_storage_libsecret_warning':
    'Credentials stored in the system keyring via libsecret.',
  'secure_storage_libsecret_hint':
    'Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) to use the system keyring.',
  'bash_security_parse_failed':
    'Bash command parsing failed; falling back to heuristic validation.',

  'provider_connectivity_error':
    'Provider connectivity error: %{detail}',
  'provider_local_model_hint':
    'Local model detected at %{baseUrl} — ensure server must be running before connecting.',
  'provider_local_model_started':
    'Local model connected in %{latencyMs}ms.',
  'provider_missing_baseurl_or_apikey':
    'Missing baseUrl or apiKey — please configure your provider.',
  'provider_test_timeout':
    'Request timed out (%{seconds}s) — the upstream server may be too slow.',
  'provider_upstream_error':
    'Upstream error %{status}: %{detail}',
  'provider_model_capabilities_unknown':
    'Could not determine capabilities for model %{model} — defaults apply defaults',

  'fs_symlink_unsafe':
    'Unsafe path — target is not inside allowed directories.',
  'fs_symlink_absolute_required':
    'Path must be an absolute path.',

  'fs_warning_crossing':
    'Path traversal warning — path contains symlink crossing outside the configured working directory.',
  'fs_normalized_path':
    'Path normalized from symlink outside the working directory.',

  'cli_security_notice_header':
    '— Security: cc-haha —',
  'cli_version':
    'Claude Code (cc-haha) v%{version}',
}
