import 'package:flutter/material.dart';
import '../models/message.dart';

/// Renders a single chat message — text, thinking, tool use, tool result,
/// permission request, error, or system notification.
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
            return _textBubble(colorScheme);
          case ChatMessageType.thinking:
            return _thinkingBubble(colorScheme);
          case ChatMessageType.toolUse:
            return _toolUseBubble(colorScheme);
          case ChatMessageType.toolResult:
            return _toolResultBubble(colorScheme);
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

  Widget _textBubble(ColorScheme colorScheme) {
    final text = message.text ?? '';
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
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
    );
  }

  Widget _thinkingBubble(ColorScheme colorScheme) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Text(
        message.thinking ?? '',
        style: TextStyle(
          color: colorScheme.onSurfaceVariant,
          fontStyle: FontStyle.italic,
          fontSize: 13,
        ),
      ),
    );
  }

  Widget _toolUseBubble(ColorScheme colorScheme) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Colors.indigo.shade50,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.indigo.shade200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.build, size: 16, color: Colors.indigo.shade700),
              const SizedBox(width: 6),
              Text(
                'Tool: ${message.toolName ?? ''}',
                style: TextStyle(
                  fontWeight: FontWeight.w600,
                  color: Colors.indigo.shade700,
                  fontSize: 13,
                ),
              ),
            ],
          ),
          if (message.toolInput != null && message.toolInput!.isNotEmpty) ...[
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Colors.indigo.shade100.withOpacity(0.5),
                borderRadius: BorderRadius.circular(6),
              ),
              child: SelectableText(
                message.toolInput!,
                style: TextStyle(
                  fontSize: 12,
                  color: Colors.indigo.shade900,
                  fontFamily: 'monospace',
                ),
              ),
            ),
          ],
          if (isStreaming)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: _cursor(colorScheme),
            ),
        ],
      ),
    );
  }

  Widget _toolResultBubble(ColorScheme colorScheme) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: message.toolIsError
            ? Colors.red.shade50
            : Colors.green.shade50,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: message.toolIsError
              ? Colors.red.shade200
              : Colors.green.shade200,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                message.toolIsError ? Icons.error : Icons.check_circle,
                size: 16,
                color: message.toolIsError
                    ? Colors.red.shade700
                    : Colors.green.shade700,
              ),
              const SizedBox(width: 6),
              Text(
                message.toolIsError ? 'Error' : 'Result',
                style: TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                  color: message.toolIsError
                      ? Colors.red.shade700
                      : Colors.green.shade700,
                ),
              ),
            ],
          ),
          if (message.toolResult != null &&
              message.toolResult!.isNotEmpty) ...[
            const SizedBox(height: 6),
            SelectableText(
              message.toolResult!,
              style: TextStyle(
                fontSize: 12,
                color: message.toolIsError
                    ? Colors.red.shade900
                    : Colors.green.shade900,
                fontFamily: 'monospace',
              ),
            ),
          ],
        ],
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
              style: TextStyle(
                fontSize: 13,
                color: Colors.orange.shade800,
              ),
            ),
          ],
          if (message.toolInput != null &&
              message.toolInput!.isNotEmpty) ...[
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
                style: TextStyle(
                  fontSize: 12,
                  fontFamily: 'monospace',
                  color: Colors.orange.shade900,
                ),
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
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.red.shade700,
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(
                  onPressed: onApprove,
                  icon: const Icon(Icons.check, size: 16),
                  label: const Text('Approve'),
                  style: FilledButton.styleFrom(
                    backgroundColor: Colors.green.shade600,
                  ),
                ),
              ],
            ),
          ] else ...[
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                '✔ Responded',
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
    // Show token usage if available
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
