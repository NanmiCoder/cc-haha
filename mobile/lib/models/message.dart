/// Server message types — mirrors the server WebSocket protocol.
/// See: src/server/ws/events.ts

// ─── Client → Server messages ─────────────────────────────────────────────

abstract class ClientMessage {
  Map<String, dynamic> toJson();
}

class PingMessage extends ClientMessage {
  @override
  Map<String, dynamic> toJson() => {'type': 'ping'};
}

class StopGenerationMessage extends ClientMessage {
  @override
  Map<String, dynamic> toJson() => {'type': 'stop_generation'};
}

class UserMessage extends ClientMessage {
  final String content;
  final List<Map<String, dynamic>>? attachments;

  UserMessage({required this.content, this.attachments});

  @override
  Map<String, dynamic> toJson() => {
        'type': 'user_message',
        'content': content,
        if (attachments != null) 'attachments': attachments,
      };
}

class PermissionResponseMessage extends ClientMessage {
  final String requestId;
  final bool allowed;
  final String? rule;

  PermissionResponseMessage({
    required this.requestId,
    required this.allowed,
    this.rule,
  });

  @override
  Map<String, dynamic> toJson() => {
        'type': 'permission_response',
        'requestId': requestId,
        'allowed': allowed,
        if (rule != null) 'rule': rule,
      };
}

class SetPermissionModeMessage extends ClientMessage {
  final String mode;

  SetPermissionModeMessage({required this.mode});

  @override
  Map<String, dynamic> toJson() => {
        'type': 'set_permission_mode',
        'mode': mode,
      };
}

// ─── Server → Client messages ─────────────────────────────────────────────

class ServerMessage {
  final String type;
  final Map<String, dynamic> data;

  ServerMessage({required this.type, required this.data});

  factory ServerMessage.fromJson(Map<String, dynamic> json) {
    return ServerMessage(type: json['type'] as String? ?? '', data: json);
  }

  // Convenience getters for common fields
  String? get text => data['text'] as String?;
  String? get toolInput => data['toolInput'] as String?;
  String? get toolName => data['toolName'] as String?;
  String? get toolUseId => data['toolUseId'] as String?;
  String? get blockType => data['blockType'] as String?;
  String? get requestId => data['requestId'] as String?;
  String? get sessionId => data['sessionId'] as String?;
  String? get code => data['code'] as String?;
  String? get message => data['message'] as String?;
  Map<String, dynamic>? get usage => data['usage'] as Map<String, dynamic>?;
  Map<String, dynamic>? get input => data['input'] as Map<String, dynamic>?;
}

/// Parsed message for display in the chat UI.
class ChatMessage {
  final String id;
  final String sessionId;
  final DateTime timestamp;
  ChatMessageType msgType;
  String? text; // Accumulated text for streaming
  String? toolName;
  String? toolInput;
  String? toolResult;
  bool toolIsError;
  String? requestId;
  String? permissionDescription;
  bool permissionPending;
  String? thinking;
  Map<String, dynamic>? tokenUsage;
  String? errorText;

  ChatMessage({
    required this.id,
    required this.sessionId,
    DateTime? timestamp,
    this.msgType = ChatMessageType.text,
    this.text,
    this.toolName,
    this.toolInput,
    this.toolResult,
    this.toolIsError = false,
    this.requestId,
    this.permissionDescription,
    this.permissionPending = true,
    this.thinking,
    this.tokenUsage,
    this.errorText,
  }) : timestamp = timestamp ?? DateTime.now();
}

enum ChatMessageType {
  text,
  thinking,
  toolUse,
  toolResult,
  permissionRequest,
  status,
  error,
  system,
}
