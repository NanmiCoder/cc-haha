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
  final _focusNode = FocusNode();
  int _lastMessageCount = 0;
  bool _initialScrollDone = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scrollToBottom();
      context.read<AppState>().loadModels();
    });
  }

  @override
  void dispose() {
    _textController.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    if (!_scrollController.hasClients) return;
    _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
  }

  void _maybeScrollToBottom() {
    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    if (position.maxScrollExtent - position.pixels < 200) {
      _scrollToBottom();
    }
  }

  @override
  Widget build(BuildContext context) {
    final appState = context.watch<AppState>();
    final colorScheme = Theme.of(context).colorScheme;
    final messages = appState.messages;
    final streamingMessage = appState.streamingMessage;

    if (messages.length > _lastMessageCount) {
      _lastMessageCount = messages.length;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_initialScrollDone) {
          _initialScrollDone = true;
          _scrollToBottom();
        } else {
          _maybeScrollToBottom();
        }
      });
    }

    if (streamingMessage != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _maybeScrollToBottom());
    }

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              appState.currentWorkDir?.split('/').last ?? 'Chat',
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
            ),
            if (appState.currentWorkDir != null)
              Text(
                appState.currentWorkDir!,
                style: TextStyle(fontSize: 10, color: colorScheme.onSurfaceVariant),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
          ],
        ),
        actions: [
          // Model selector
          if (appState.availableModels.isNotEmpty)
            PopupMenuButton<String>(
              tooltip: 'Select model',
              initialValue: appState.currentModel,
              onSelected: (modelId) => appState.setModel(modelId),
              itemBuilder: (_) => appState.availableModels.map((m) {
                final id = m['id'] as String? ?? '';
                return PopupMenuItem<String>(
                  value: id,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (id == appState.currentModel)
                        Icon(Icons.check, size: 16, color: colorScheme.primary)
                      else
                        const SizedBox(width: 16),
                      const SizedBox(width: 8),
                      Text(id, style: const TextStyle(fontSize: 13)),
                    ],
                  ),
                );
              }).toList(),
              child: Chip(
                label: Text(
                  appState.currentModel.isNotEmpty ? appState.currentModel : 'Model',
                  style: const TextStyle(fontSize: 11),
                ),
                avatar: const Icon(Icons.smart_toy, size: 14),
                padding: EdgeInsets.zero,
                visualDensity: VisualDensity.compact,
              ),
            ),
          if (appState.isStreaming)
            IconButton(
              icon: const Icon(Icons.stop_circle_outlined),
              tooltip: 'Stop generation',
              onPressed: () => appState.stopGeneration(),
            ),
        ],
      ),
      body: Column(
        children: [
          ConnectionStatus(
            status: appState.chatStatus,
            isStreaming: appState.isStreaming,
            workDir: appState.currentWorkDir,
          ),

          // Streaming status banner
          if (appState.isStreaming || appState.chatStatus.isNotEmpty)
            _buildStreamingBanner(appState, colorScheme),

          Expanded(
            child: messages.isEmpty && streamingMessage == null
                ? Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.chat, size: 48, color: colorScheme.onSurfaceVariant),
                        const SizedBox(height: 12),
                        Text(
                          'Send a message to start',
                          style: TextStyle(color: colorScheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  )
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    itemCount: messages.length + (streamingMessage != null ? 1 : 0),
                    itemBuilder: (context, index) {
                      if (streamingMessage != null && index == messages.length) {
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

          // Composer
          Container(
            decoration: BoxDecoration(
              color: colorScheme.surface,
              border: Border(
                top: BorderSide(color: colorScheme.outlineVariant.withValues(alpha: 0.3)),
              ),
            ),
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _textController,
                        focusNode: _focusNode,
                        decoration: InputDecoration(
                          hintText: appState.isStreaming
                              ? 'AI is responding...'
                              : 'Type a message...',
                          filled: true,
                          fillColor: colorScheme.surfaceContainerHighest,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(24),
                            borderSide: BorderSide.none,
                          ),
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 18,
                            vertical: 12,
                          ),
                          isDense: true,
                        ),
                        enabled: !appState.isStreaming,
                        textInputAction: TextInputAction.newline,
                        maxLines: 4,
                        minLines: 2,
                        onSubmitted: (_) => _send(_textController.text),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Material(
                      color: colorScheme.primary,
                      shape: const CircleBorder(),
                      clipBehavior: Clip.antiAlias,
                      child: IconButton(
                        icon: const Icon(Icons.arrow_upward, color: Colors.white, size: 20),
                        onPressed: () => _send(_textController.text),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStreamingBanner(AppState appState, ColorScheme colorScheme) {
    final isWaiting = appState.chatStatus == 'Thinking...' && !appState.isStreaming;
    final statusText = appState.chatStatus.isNotEmpty ? appState.chatStatus : 'Processing...';

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      color: colorScheme.primaryContainer.withValues(alpha: 0.3),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: colorScheme.primary,
            ),
          ),
          const SizedBox(width: 10),
          Text(
            statusText,
            style: TextStyle(
              fontSize: 12,
              color: colorScheme.onSurfaceVariant,
              fontStyle: FontStyle.italic,
            ),
          ),
          if (isWaiting) ...[
            const SizedBox(width: 6),
            _waitingDots(),
          ],
        ],
      ),
    );
  }

  Widget _waitingDots() {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: const Duration(milliseconds: 1200),
      builder: (_, v, __) {
        final n = (v * 3).floor() + 1;
        final dots = List.filled(n, '.').join();
        return Text(
          dots,
          style: TextStyle(
            fontSize: 14,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontWeight: FontWeight.bold,
          ),
        );
      },
    );
  }

  void _send(String text) {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;

    _textController.clear();
    _focusNode.requestFocus();
    context.read<AppState>().sendMessage(trimmed);
    Future.delayed(const Duration(milliseconds: 100), () => _scrollToBottom());
  }
}
