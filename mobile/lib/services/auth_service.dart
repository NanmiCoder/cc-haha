import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../config/app_config.dart';

/// Manages secure storage of the API key and server URL.
class AuthService {
  static const _keyApiKey = 'haha_api_key';
  static const _keyServerUrl = 'haha_server_url';

  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  Future<bool> isConfigured() async {
    final key = await _storage.read(key: _keyApiKey);
    final url = await _storage.read(key: _keyServerUrl);
    return (key?.isNotEmpty ?? false) && (url?.isNotEmpty ?? false);
  }

  Future<void> loadConfig() async {
    final key = await _storage.read(key: _keyApiKey);
    final url = await _storage.read(key: _keyServerUrl);
    if (key != null && url != null) {
      AppConfig.apiKey = key;
      AppConfig.serverUrl = url;
    }
  }

  Future<void> saveConfig({
    required String apiKey,
    required String serverUrl,
  }) async {
    await _storage.write(key: _keyApiKey, value: apiKey);
    await _storage.write(key: _keyServerUrl, value: serverUrl);
    AppConfig.apiKey = apiKey;
    AppConfig.serverUrl = serverUrl;
  }

  Future<void> clearConfig() async {
    await _storage.delete(key: _keyApiKey);
    await _storage.delete(key: _keyServerUrl);
    AppConfig.apiKey = '';
  }
}
