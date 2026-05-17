import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import '../models/message.dart';
import '../models/session.dart';
import '../services/api_client.dart';
import '../services/websocket_client.dart';
import '../services/auth_service.dart';
import '../services/notification_service.dart';
import '../config/app_config.dart';

/// Central application state — manages auth, sessions, and active chat.
class AppState extends ChangeNotifier {
  final ApiClient api = ApiClient();
  final AuthService authService = AuthService();
  late final NotificationService notificationService =
      NotificationService(api: api);

  // ─── Connection state ─────────────────────────────────────────────────

  bool _isConfigured = false;
  bool get isConfigured => _isConfigured;

  bool _isConnecting = false;
  bool get isConnecting => _isConnecting;

  String? _connectionError;
  String? get connectionError => _connectionError;

  // ─── Sessions ─────────────────────────────────────────────────────────

  List<Session> _sessions = [];
  List<Session> get sessions => _sessions;

  bool _sessionsLoading = false;
  bool get sessionsLoading => _sessionsLoading;

  // ─── Active chat ──────────────────────────────────────────────────────

  String? _activeSessionId;
  String? get activeSessionId => _activeSessionId;

  String? _currentWorkDir;
  String? get currentWorkDir => _currentWorkDir;

  String _currentModel = '';
  String get currentModel => _currentModel;
  List<Map<String, dynamic>> _availableModels = [];
  List<Map<String, dynamic>> get availableModels => _availableModels;

  List<ChatMessage> _messages = [];
  List<ChatMessage> get messages => _messages;

  WebSocketClient? _ws;
  bool _isStreaming = false;
  bool get isStreaming => _isStreaming;

  String _chatStatus = '';
  String get chatStatus => _chatStatus;

  /// The message currently being streamed (accumulates content_delta text).
  ChatMessage? _streamingMessage;
  ChatMessage? get streamingMessage => _streamingMessage;

  /// Cache last message timestamp per session for incremental loading.
  final Map<String, String> _sessionLastTimestamps = {};

  // ─── Auth / Connection ────────────────────────────────────────────────

  Future<void> initialize() async {
    // Init JPush (registration ID is obtained async, registers with server later)
    if (AppConfig.jpushAppKey != 'YOUR_JPUSH_APP_KEY') {
      notificationService.init(
        appKey: AppConfig.jpushAppKey,
        isProduction: false,
      );
    }

    _isConfigured = await authService.isConfigured();
    if (_isConfigured) {
      await authService.loadConfig();
    }
    notifyListeners();
  }

  Future<String?> connect({
    required String serverUrl,
    required String apiKey,
  }) async {
    _isConnecting = true;
    _connectionError = null;
    notifyListeners();

    // Temporarily set config for the test connection
    final prevUrl = AppConfig.serverUrl;
    final prevKey = AppConfig.apiKey;
    AppConfig.serverUrl = serverUrl;
    AppConfig.apiKey = apiKey;

    try {
      // Test connectivity
      await api.healthCheck();

      // Verify auth
      await api.authStatus();

      // Save on success
      await authService.saveConfig(apiKey: apiKey, serverUrl: serverUrl);
      _isConfigured = true;
      _connectionError = null;
      notifyListeners();
      return null;
    } catch (e) {
      // Restore previous config on failure
      AppConfig.serverUrl = prevUrl;
      AppConfig.apiKey = prevKey;
      _connectionError = e.toString();
      _isConfigured = false;
      notifyListeners();
      return e.toString();
    } finally {
      _isConnecting = false;
      notifyListeners();
    }
  }

  Future<void> disconnect() async {
    _ws?.disconnect();
    _ws = null;
    _activeSessionId = null;
    _messages = [];
    await authService.clearConfig();
    _isConfigured = false;
    notifyListeners();
  }

  // ─── Sessions ─────────────────────────────────────────────────────────

  Future<void> loadSessions() async {
    _sessionsLoading = true;
    notifyListeners();

    try {
      final list = await api.listSessions();
      _sessions = list.map((j) => Session.fromJson(j)).toList();
    } catch (e) {
      _connectionError = e.toString();
    }

    _sessionsLoading = false;
    notifyListeners();
  }

  Future<Session?> createSession({String? workDir}) async {
    try {
      final data = await api.createSession(workDir: workDir);
      final session = Session(
        id: (data['sessionId'] ?? data['id']) as String? ?? '',
        title: data['title'] as String? ?? 'New Session',
        workDir: data['workDir'] as String? ?? workDir ?? '',
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      );
      _sessions.insert(0, session);
      notifyListeners();
      return session;
    } catch (e) {
      _connectionError = e.toString();
      notifyListeners();
      return null;
    }
  }

  Future<void> deleteSession(String sessionId) async {
    try {
      await api.deleteSession(sessionId);
      _sessions.removeWhere((s) => s.id == sessionId);
      if (_activeSessionId == sessionId) {
        _activeSessionId = null;
        _messages = [];
      }
      notifyListeners();
    } catch (e) {
      _connectionError = e.toString();
      notifyListeners();
    }
  }

  // ─── Chat ─────────────────────────────────────────────────────────────

  Future<void> openSession(String sessionId, {String? workDir}) async {
    _activeSessionId = sessionId;
    _currentWorkDir = workDir;
    _messages = [];
    _streamingMessage = null;
    _isStreaming = false;
    _chatStatus = 'Loading...';
    notifyListeners();

    // Load existing messages via REST API (incremental: only new since last visit)
    try {
      final since = _sessionLastTimestamps[sessionId];
      final rawMessages = await api.getMessages(sessionId, since: since);
      for (final m in rawMessages) {
        final type = m['type'] as String?;
        final content = m['content'];
        final text = _extractText(content);

        switch (type) {
          case 'user':
            _messages.add(ChatMessage(
              id: m['id']?.toString() ?? DateTime.now().microsecondsSinceEpoch.toString(),
              sessionId: sessionId,
              msgType: ChatMessageType.text,
              text: text,
            ));
            break;
          case 'assistant':
            _messages.add(ChatMessage(
              id: m['id']?.toString() ?? DateTime.now().microsecondsSinceEpoch.toString(),
              sessionId: sessionId,
              msgType: ChatMessageType.text,
              text: text,
            ));
            break;
          case 'tool_use':
            final toolBlocks = _extractToolBlocks(content);
            for (final tb in toolBlocks) {
              _messages.add(ChatMessage(
                id: m['id']?.toString() ?? DateTime.now().microsecondsSinceEpoch.toString(),
                sessionId: sessionId,
                msgType: ChatMessageType.toolUse,
                toolName: tb['name'] as String? ?? '',
                toolInput: _formatJson(tb['input']),
              ));
            }
            break;
          case 'tool_result':
            _messages.add(ChatMessage(
              id: m['id']?.toString() ?? DateTime.now().microsecondsSinceEpoch.toString(),
              sessionId: sessionId,
              msgType: ChatMessageType.toolResult,
              toolResult: _formatJson(content),
            ));
            break;
          case 'system':
            _messages.add(ChatMessage(
              id: m['id']?.toString() ?? DateTime.now().microsecondsSinceEpoch.toString(),
              sessionId: sessionId,
              msgType: ChatMessageType.system,
              text: text,
            ));
            break;
        }
      }
      // Update cache with the most recent message timestamp
      if (rawMessages.isNotEmpty) {
        final lastTimestamp = rawMessages.last['timestamp'] as String?;
        if (lastTimestamp != null) {
          _sessionLastTimestamps[sessionId] = lastTimestamp;
        }
      }
    } catch (e) {
      debugPrint('[haha] Failed to load history: $e');
    }

    _chatStatus = 'Connected';
    notifyListeners();

    // Connect WebSocket for real-time streaming
    _ws?.disconnect();
    _ws = WebSocketClient(
      sessionId: sessionId,
      onMessage: _handleServerMessage,
    );
    _ws!.connect();

    notifyListeners();
  }

  void closeSession() {
    _ws?.disconnect();
    _ws = null;
    _activeSessionId = null;
    _messages = [];
    _streamingMessage = null;
    _isStreaming = false;
    notifyListeners();
  }

  Future<void> loadModels() async {
    try {
      final data = await api.getModels();
      _availableModels = (data['models'] as List<dynamic>?)
              ?.cast<Map<String, dynamic>>() ??
          [];
      final current = await api.get('/api/models/current');
      _currentModel = (current['model'] as Map<String, dynamic>?)?['id'] as String? ?? '';
    } catch (_) {
      // Models optional, use empty list
    }
    notifyListeners();
  }

  Future<void> setModel(String modelId) async {
    try {
      await api.setModel(modelId);
      _currentModel = modelId;
      notifyListeners();
    } catch (e) {
      debugPrint('[haha] Failed to set model: $e');
    }
  }

  void sendMessage(String content) {
    // Add user message to local list immediately
    _messages.add(ChatMessage(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      sessionId: _activeSessionId ?? '',
      msgType: ChatMessageType.text,
      role: ChatRole.user,
      text: content,
    ));

    if (_ws == null || !_ws!.isConnected) {
      _ws?.connect();
    }
    _ws?.send(UserMessage(content: content));
    _isStreaming = true;
    _chatStatus = 'Thinking...';
    notifyListeners();
  }

  void stopGeneration() {
    _ws?.send(StopGenerationMessage());
    notifyListeners();
  }

  void respondToPermission({
    required String requestId,
    required bool allowed,
  }) {
    _ws?.send(PermissionResponseMessage(
      requestId: requestId,
      allowed: allowed,
    ));
  }

  void _handleServerMessage(ServerMessage msg) {
    switch (msg.type) {
      case 'connected':
        _chatStatus = 'Connected';
        break;

      case 'content_start':
        final blockType = msg.blockType;
        if (blockType == 'text') {
          _streamingMessage = ChatMessage(
            id: DateTime.now().microsecondsSinceEpoch.toString(),
            sessionId: _activeSessionId ?? '',
            msgType: ChatMessageType.text,
            text: '',
          );
        } else if (blockType == 'tool_use') {
          _streamingMessage = ChatMessage(
            id: DateTime.now().microsecondsSinceEpoch.toString(),
            sessionId: _activeSessionId ?? '',
            msgType: ChatMessageType.toolUse,
            toolName: msg.toolName,
            toolInput: '',
          );
        } else if (blockType == 'thinking') {
          _streamingMessage = ChatMessage(
            id: DateTime.now().microsecondsSinceEpoch.toString(),
            sessionId: _activeSessionId ?? '',
            msgType: ChatMessageType.thinking,
            thinking: '',
          );
          _messages.add(_streamingMessage!);
        }
        break;

      case 'content_delta':
        if (_streamingMessage != null) {
          if (_streamingMessage!.msgType == ChatMessageType.text) {
            _streamingMessage!.text =
                (_streamingMessage!.text ?? '') + (msg.text ?? '');
          } else if (_streamingMessage!.msgType == ChatMessageType.toolUse) {
            _streamingMessage!.toolInput =
                (_streamingMessage!.toolInput ?? '') + (msg.toolInput ?? '');
          } else if (_streamingMessage!.msgType == ChatMessageType.thinking) {
            _streamingMessage!.thinking =
                (_streamingMessage!.thinking ?? '') + (msg.text ?? '');
          }
        }
        break;

      case 'tool_use_complete':
        if (_streamingMessage != null &&
            _streamingMessage!.msgType == ChatMessageType.toolUse) {
          _streamingMessage!.toolInput = _formatJson(msg.data['input']);
          _messages.add(_streamingMessage!);
          _streamingMessage = null;
        }
        break;

      case 'tool_result':
        final resultMsg = ChatMessage(
          id: DateTime.now().microsecondsSinceEpoch.toString(),
          sessionId: _activeSessionId ?? '',
          msgType: ChatMessageType.toolResult,
          toolResult: _formatJson(msg.data['content']),
          toolIsError: msg.data['isError'] == true,
        );
        _messages.add(resultMsg);
        break;

      case 'permission_request':
        final permMsg = ChatMessage(
          id: DateTime.now().microsecondsSinceEpoch.toString(),
          sessionId: _activeSessionId ?? '',
          msgType: ChatMessageType.permissionRequest,
          requestId: msg.requestId,
          toolName: msg.toolName,
          toolInput: _formatJson(msg.input),
          permissionDescription: msg.data['description'] as String?,
          permissionPending: true,
        );
        _messages.add(permMsg);
        break;

      case 'thinking':
        // Accumulate thinking deltas into a single streaming message
        if (_streamingMessage != null &&
            _streamingMessage!.msgType == ChatMessageType.thinking) {
          _streamingMessage!.thinking =
              (_streamingMessage!.thinking ?? '') + (msg.text ?? '');
        } else {
          _streamingMessage = ChatMessage(
            id: DateTime.now().microsecondsSinceEpoch.toString(),
            sessionId: _activeSessionId ?? '',
            msgType: ChatMessageType.thinking,
            thinking: msg.text ?? '',
          );
          _messages.add(_streamingMessage!);
        }
        break;

      case 'message_complete':
        if (_streamingMessage != null) {
          _messages.add(_streamingMessage!);
          _streamingMessage = null;
        }
        _isStreaming = false;
        _chatStatus = 'Done';
        if (msg.usage != null) {
          final tokensMsg = ChatMessage(
            id: DateTime.now().microsecondsSinceEpoch.toString(),
            sessionId: _activeSessionId ?? '',
            msgType: ChatMessageType.system,
            tokenUsage: msg.usage,
          );
          _messages.add(tokensMsg);
        }
        break;

      case 'error':
        final errMsg = ChatMessage(
          id: DateTime.now().microsecondsSinceEpoch.toString(),
          sessionId: _activeSessionId ?? '',
          msgType: ChatMessageType.error,
          errorText: msg.message ?? msg.code ?? 'Unknown error',
        );
        _messages.add(errMsg);
        break;

      case 'status':
        final state = msg.data['state'] as String? ?? '';
        _chatStatus = state;
        break;

      case 'system_notification':
        final subtype = msg.data['subtype'] as String? ?? '';
        final sysMsg = ChatMessage(
          id: DateTime.now().microsecondsSinceEpoch.toString(),
          sessionId: _activeSessionId ?? '',
          msgType: ChatMessageType.system,
          text: '[$subtype] ${msg.message ?? ''}',
        );
        _messages.add(sysMsg);
        break;

      case 'session_title_updated':
        // Title updated — will be reflected on next sessions reload
        break;
    }

    notifyListeners();
  }

  /// Extract plain text from content which may be a String or an array of blocks.
  String _extractText(dynamic content) {
    if (content is String) return content;
    if (content is List) {
      final texts = <String>[];
      for (final block in content) {
        if (block is Map && block['type'] == 'text') {
          final t = block['text'];
          if (t is String) texts.add(t);
        }
      }
      return texts.join('\n');
    }
    return '';
  }

  /// Extract tool_use blocks from an array of content blocks.
  List<Map<String, dynamic>> _extractToolBlocks(dynamic content) {
    if (content is List) {
      return content
          .whereType<Map<String, dynamic>>()
          .where((b) => b['type'] == 'tool_use')
          .toList();
    }
    return [];
  }

  String _formatJson(dynamic obj) {
    if (obj is String) return obj;
    if (obj == null) return '';
    try {
      return const JsonEncoder.withIndent('  ').convert(obj);
    } catch (_) {
      return obj.toString();
    }
  }

  @override
  void dispose() {
    _ws?.disconnect();
    api.dispose();
    super.dispose();
  }
}
