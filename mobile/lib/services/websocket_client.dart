import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../config/app_config.dart';
import '../models/message.dart';

/// WebSocket client — mirrors desktop/src/api/websocket.ts WebSocketManager.
///
/// Features:
/// - Auto-reconnect with exponential backoff (1s → 2s → 4s → … → 30s cap)
/// - 30s ping/pong heartbeat
/// - Pending message queue (drained on reconnect)
/// - Per-session message handler registration
class WebSocketClient {
  final String sessionId;
  final void Function(ServerMessage) onMessage;

  WebSocketChannel? _channel;
  Timer? _pingTimer;
  Timer? _reconnectTimer;
  int _reconnectAttempt = 0;
  bool _intentionalClose = false;
  bool _isOpen = false;
  final List<ClientMessage> _pendingMessages = [];

  WebSocketClient({
    required this.sessionId,
    required this.onMessage,
  });

  bool get isConnected => _isOpen;

  void connect() {
    if (_isOpen) return;
    _intentionalClose = false;

    final url = '${AppConfig.wsUrl}/ws/$sessionId';
    try {
      _channel = WebSocketChannel.connect(Uri.parse(url));
      _isOpen = true;

      _channel!.stream.listen(
        _onData,
        onError: _onError,
        onDone: _onDone,
      );

      _startPingLoop();

      // Drain pending messages
      for (final msg in _pendingMessages) {
        _sendRaw(msg);
      }
      _pendingMessages.clear();

      _reconnectAttempt = 0;
    } catch (e) {
      _isOpen = false;
      _scheduleReconnect();
    }
  }

  void disconnect() {
    _intentionalClose = true;
    _stopPingLoop();
    _cancelReconnect();
    _pendingMessages.clear();
    _isOpen = false;
    _channel?.sink.close();
    _channel = null;
  }

  void send(ClientMessage message) {
    if (_isOpen) {
      _sendRaw(message);
    } else {
      _pendingMessages.add(message);
      if (!_intentionalClose) {
        _scheduleReconnect();
      }
    }
  }

  void _sendRaw(ClientMessage message) {
    final json = jsonEncode(message.toJson());
    _channel?.sink.add(json);
  }

  void _onData(dynamic data) {
    try {
      final json = jsonDecode(data as String) as Map<String, dynamic>;
      final msg = ServerMessage.fromJson(json);
      onMessage(msg);
    } catch (_) {
      // Silently ignore malformed messages (matches desktop behavior)
    }
  }

  void _onError(dynamic error) {
    _isOpen = false;
  }

  void _onDone() {
    _isOpen = false;
    _stopPingLoop();
    if (!_intentionalClose) {
      _scheduleReconnect();
    }
  }

  // ─── Ping / Pong ──────────────────────────────────────────────────────

  void _startPingLoop() {
    _pingTimer?.cancel();
    _pingTimer = Timer.periodic(AppConfig.wsPingInterval, (_) {
      if (_isOpen) {
        _sendRaw(PingMessage());
      }
    });
  }

  void _stopPingLoop() {
    _pingTimer?.cancel();
    _pingTimer = null;
  }

  // ─── Reconnect ────────────────────────────────────────────────────────

  void _scheduleReconnect() {
    if (_intentionalClose) return;
    _cancelReconnect();

    final delay = Duration(
      milliseconds: (AppConfig.wsReconnectBaseMs *
                  (1 << _reconnectAttempt.clamp(0, 5)))
              .clamp(0, AppConfig.wsReconnectCap.inMilliseconds)
          .toInt(),
    );
    _reconnectAttempt++;

    _reconnectTimer = Timer(delay, () {
      if (!_intentionalClose) {
        connect();
      }
    });
  }

  void _cancelReconnect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
  }
}
