import 'package:flutter/material.dart';
import '../models/message.dart';
import 'thinking_block.dart';
import 'tool_call_block.dart';
import 'tool_result_block.dart';

/// Renders a chat message by dispatching to the appropriate block component.
/// Component structure matches the desktop app: ThinkingBlock, ToolCallBlock, ToolResultBlock.
class ChatBubble extends StatelessWidget {
  final ChatMessage message;
  final bool isStreaming;
  final void Function()? onApprove;
  final void Function()? onDeny;

  const ChatBubble({
    super.key,
    required this.message,
    this.isStreaming = false,
    this.onApprove,
    this.onDeny,
  });

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: () {
        switch (message.msgType) {
          case ChatMessageType.text:
            return _textBubble(colorScheme, context);
          case ChatMessageType.thinking:
            return ThinkingBlock(
              content: message.thinking ?? '',
              isActive: isStreaming,
            );
          case ChatMessageType.toolUse:
            return ToolCallBlock(
              toolName: message.toolName ?? '',
              toolInput: message.toolInput,
              isStreaming: isStreaming,
            );
          case ChatMessageType.toolResult:
            return ToolResultBlock(
              content: message.toolResult,
              isError: message.toolIsError,
            );
          case ChatMessageType.permissionRequest:
            return _permissionBubble(colorScheme);
          case ChatMessageType.status:
            return _statusBubble(colorScheme);
          case ChatMessageType.error:
            return _errorBubble(colorScheme);
          case ChatMessageType.system:
            return _systemBubble(colorScheme);
        }
      }(),
    );
  }

  Widget _textBubble(ColorScheme colorScheme, BuildContext ctx) {
    final text = message.text ?? '';
    final isUser = message.role == ChatRole.user;

    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(ctx).size.width * 0.82,
        ),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: isUser
              ? colorScheme.primaryContainer
              : colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(16),
            topRight: const Radius.circular(16),
            bottomLeft: Radius.circular(isUser ? 16 : 4),
            bottomRight: Radius.circular(isUser ? 4 : 16),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            SelectableText(
              text,
              style: TextStyle(color: colorScheme.onSurface),
            ),
            if (isStreaming)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: _cursor(colorScheme),
              ),
          ],
        ),
      ),
    );
  }

  Widget _permissionBubble(ColorScheme colorScheme) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.orange.shade50,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.orange.shade300),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.security, size: 18, color: Colors.orange.shade700),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'haha wants to use: ${message.toolName ?? 'tool'}',
                  style: TextStyle(
                    fontWeight: FontWeight.w600,
                    color: Colors.orange.shade900,
                  ),
                ),
              ),
            ],
          ),
          if (message.permissionDescription != null) ...[
            const SizedBox(height: 4),
            Text(
              message.permissionDescription!,
              style: TextStyle(fontSize: 13, color: Colors.orange.shade800),
            ),
          ],
          if (message.toolInput != null && message.toolInput!.isNotEmpty) ...[
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Colors.orange.shade100,
                borderRadius: BorderRadius.circular(6),
              ),
              child: SelectableText(
                message.toolInput!,
                style: TextStyle(fontSize: 12, fontFamily: 'monospace', color: Colors.orange.shade900),
                maxLines: 6,
              ),
            ),
          ],
          if (message.permissionPending) ...[
            const SizedBox(height: 10),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                OutlinedButton.icon(
                  onPressed: onDeny,
                  icon: const Icon(Icons.close, size: 16),
                  label: const Text('Deny'),
                  style: OutlinedButton.styleFrom(foregroundColor: Colors.red.shade700),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(
                  onPressed: onApprove,
                  icon: const Icon(Icons.check, size: 16),
                  label: const Text('Approve'),
                  style: FilledButton.styleFrom(backgroundColor: Colors.green.shade600),
                ),
              ],
            ),
          ] else ...[
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                'Responded',
                style: TextStyle(
                  color: colorScheme.onSurfaceVariant,
                  fontSize: 12,
                  fontStyle: FontStyle.italic,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _statusBubble(ColorScheme colorScheme) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Center(
        child: Text(
          message.text ?? '',
          style: TextStyle(
            color: colorScheme.onSurfaceVariant,
            fontSize: 11,
            fontStyle: FontStyle.italic,
          ),
        ),
      ),
    );
  }

  Widget _errorBubble(ColorScheme colorScheme) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Colors.red.shade50,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.red.shade200),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline, size: 18, color: Colors.red.shade700),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message.errorText ?? 'Unknown error',
              style: TextStyle(color: Colors.red.shade800, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  Widget _systemBubble(ColorScheme colorScheme) {
    if (message.tokenUsage != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Center(
          child: Text(
            'Tokens: ${message.tokenUsage!['input_tokens'] ?? 0} in / ${message.tokenUsage!['output_tokens'] ?? 0} out',
            style: TextStyle(
              color: colorScheme.onSurfaceVariant,
              fontSize: 11,
              fontStyle: FontStyle.italic,
            ),
          ),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Center(
        child: Text(
          message.text ?? '',
          style: TextStyle(
            color: colorScheme.onSurfaceVariant,
            fontSize: 11,
            fontStyle: FontStyle.italic,
          ),
        ),
      ),
    );
  }

  Widget _cursor(ColorScheme colorScheme) {
    return Container(
      width: 8,
      height: 14,
      decoration: BoxDecoration(
        color: colorScheme.onSurface,
        borderRadius: BorderRadius.circular(2),
      ),
    );
  }
}
