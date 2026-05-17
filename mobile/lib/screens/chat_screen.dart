import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/message.dart';
import '../providers/app_state.dart';
import '../widgets/chat_bubble.dart';
import '../widgets/connection_status.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _textController = TextEditingController();
  final _scrollController = ScrollController();

  @override
  void dispose() {
    _textController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final appState = context.watch<AppState>();
    final colorScheme = Theme.of(context).colorScheme;
    final messages = appState.messages;
    final streamingMessage = appState.streamingMessage;

    return Scaffold(
      appBar: AppBar(
        title: Text(appState.activeSessionId ?? 'Chat'),
        actions: [
          if (appState.isStreaming)
            IconButton(
              icon: const Icon(Icons.stop),
              tooltip: 'Stop generation',
              onPressed: () => appState.stopGeneration(),
            ),
        ],
      ),
      body: Column(
        children: [
          // Connection + status indicator
          ConnectionStatus(
            status: appState.chatStatus,
            isStreaming: appState.isStreaming,
          ),

          // Messages list
          Expanded(
            child: messages.isEmpty && streamingMessage == null
                ? Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.chat,
                            size: 48, color: colorScheme.onSurfaceVariant),
                        const SizedBox(height: 12),
                        Text(
                          'Send a message to start',
                          style: TextStyle(
                              color: colorScheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  )
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 8),
                    itemCount: messages.length +
                        (streamingMessage != null ? 1 : 0),
                    itemBuilder: (context, index) {
                      // Last item = streaming message
                      if (streamingMessage != null &&
                          index == messages.length) {
                        return ChatBubble(
                          message: streamingMessage,
                          isStreaming: true,
                          onApprove: null,
                          onDeny: null,
                        );
                      }

                      final msg = messages[index];
                      void Function()? onApprove;
                      void Function()? onDeny;

                      if (msg.msgType == ChatMessageType.permissionRequest &&
                          msg.permissionPending &&
                          msg.requestId != null) {
                        onApprove = () {
                          appState.respondToPermission(
                            requestId: msg.requestId!,
                            allowed: true,
                          );
                          msg.permissionPending = false;
                        };
                        onDeny = () {
                          appState.respondToPermission(
                            requestId: msg.requestId!,
                            allowed: false,
                          );
                          msg.permissionPending = false;
                        };
                      }

                      return ChatBubble(
                        message: msg,
                        isStreaming: false,
                        onApprove: onApprove,
                        onDeny: onDeny,
                      );
                    },
                  ),
          ),

          // Input bar
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _textController,
                      decoration: InputDecoration(
                        hintText: appState.isStreaming
                            ? 'AI is responding...'
                            : 'Type a message...',
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(24),
                        ),
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 20,
                          vertical: 12,
                        ),
                      ),
                      enabled: !appState.isStreaming,
                      textInputAction: TextInputAction.send,
                      onSubmitted: _send,
                    ),
                  ),
                  const SizedBox(width: 8),
                  CircleAvatar(
                    backgroundColor: colorScheme.primary,
                    child: IconButton(
                      icon: const Icon(Icons.send, color: Colors.white, size: 20),
                      onPressed: () => _send(_textController.text),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _send(String text) {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;

    _textController.clear();
    context.read<AppState>().sendMessage(trimmed);

    // Scroll to bottom after a short delay for the message to appear
    Future.delayed(const Duration(milliseconds: 100), () {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }
}
