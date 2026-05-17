import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/app_config.dart';

/// REST API client — mirrors desktop/src/api/client.ts pattern.
/// Sends Bearer token auth on every request.
class ApiClient {
  final http.Client _client = http.Client();

  String get _baseUrl => AppConfig.serverUrl;

  Map<String, String> get _headers {
    final h = <String, String>{
      'Content-Type': 'application/json',
    };
    if (AppConfig.apiKey.isNotEmpty) {
      h['Authorization'] = 'Bearer ${AppConfig.apiKey}';
    }
    return h;
  }

  Future<Map<String, dynamic>> get(
    String path, {
    Duration timeout = AppConfig.requestTimeout,
  }) async {
    final uri = Uri.parse('$_baseUrl$path');
    final resp = await _client.get(uri, headers: _headers).timeout(timeout);
    return _handleResponse(resp);
  }

  Future<Map<String, dynamic>> post(
    String path, {
    dynamic body,
    Duration timeout = AppConfig.requestTimeout,
  }) async {
    final uri = Uri.parse('$_baseUrl$path');
    final resp = await _client
        .post(uri, headers: _headers, body: jsonEncode(body))
        .timeout(timeout);
    return _handleResponse(resp);
  }

  Future<Map<String, dynamic>> put(
    String path, {
    dynamic body,
  }) async {
    final uri = Uri.parse('$_baseUrl$path');
    final resp = await _client
        .put(uri, headers: _headers, body: jsonEncode(body));
    return _handleResponse(resp);
  }

  Future<Map<String, dynamic>> patch(
    String path, {
    dynamic body,
  }) async {
    final uri = Uri.parse('$_baseUrl$path');
    final resp = await _client
        .patch(uri, headers: _headers, body: jsonEncode(body));
    return _handleResponse(resp);
  }

  Future<Map<String, dynamic>> delete(String path) async {
    final uri = Uri.parse('$_baseUrl$path');
    final resp = await _client.delete(uri, headers: _headers);
    return _handleResponse(resp);
  }

  Map<String, dynamic> _handleResponse(http.Response resp) {
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      if (resp.body.isEmpty) return {'ok': true};
      return jsonDecode(resp.body) as Map<String, dynamic>;
    }
    throw ApiException(
      statusCode: resp.statusCode,
      message: resp.body,
    );
  }

  // ─── Convenience API methods ──────────────────────────────────────────

  Future<List<Map<String, dynamic>>> listSessions() async {
    final data = await get('/api/sessions');
    final sessions = data['sessions'] as List<dynamic>? ?? [];
    return sessions.cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> createSession({String? workDir}) async {
    return post('/api/sessions', body: {
      if (workDir != null) 'workDir': workDir,
    });
  }

  Future<Map<String, dynamic>> getSession(String sessionId) async {
    return get('/api/sessions/$sessionId');
  }

  Future<void> deleteSession(String sessionId) async {
    await delete('/api/sessions/$sessionId');
  }

  Future<void> renameSession(String sessionId, String title) async {
    await patch('/api/sessions/$sessionId', body: {'title': title});
  }

  Future<List<Map<String, dynamic>>> getMessages(String sessionId, {String? since}) async {
    var path = '/api/sessions/$sessionId/messages';
    if (since != null) {
      path += '?since=${Uri.encodeComponent(since)}';
    }
    final data = await get(path);
    final messages = data['messages'] as List<dynamic>? ?? [];
    return messages.cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> getModels() async {
    return get('/api/models');
  }

  Future<void> setModel(String modelId) async {
    await put('/api/models/current', body: {'modelId': modelId});
  }

  Future<Map<String, dynamic>> healthCheck() async {
    return get('/health');
  }

  Future<Map<String, dynamic>> serverInfo() async {
    return get('/api/mobile/server-info');
  }

  Future<Map<String, dynamic>> authStatus() async {
    return get('/api/mobile/auth-status');
  }

  Future<void> registerDevice({
    required String deviceToken,
    required String platform,
  }) async {
    await post('/api/mobile/register-device', body: {
      'deviceToken': deviceToken,
      'platform': platform,
    });
  }

  Future<void> unregisterDevice({required String deviceToken}) async {
    await post('/api/mobile/unregister-device', body: {
      'deviceToken': deviceToken,
    });
  }

  void dispose() {
    _client.close();
  }
}

class ApiException implements Exception {
  final int statusCode;
  final String message;

  ApiException({required this.statusCode, required this.message});

  @override
  String toString() => 'ApiException($statusCode): $message';
}
