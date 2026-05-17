/// Application configuration and constants.
class AppConfig {
  // Will be set by the user on the connect screen
  static String serverUrl = 'http://localhost:3456';
  static String apiKey = '';

  /// JPush AppKey — from 极光控制台 → 应用设置.
  /// This is NOT a secret; it's embedded in the app.
  static const String jpushAppKey = 'YOUR_JPUSH_APP_KEY';

  static const String appName = 'haha';
  static const Duration requestTimeout = Duration(seconds: 30);
  static const Duration wsPingInterval = Duration(seconds: 30);
  static const Duration wsReconnectCap = Duration(seconds: 30);
  static const int wsReconnectBaseMs = 1000;

  /// Returns the WebSocket URL derived from the server URL.
  static String get wsUrl {
    final uri = Uri.parse(serverUrl);
    final scheme = uri.scheme == 'https' ? 'wss' : 'ws';
    return '$scheme://${uri.host}:${uri.port}';
  }
}
