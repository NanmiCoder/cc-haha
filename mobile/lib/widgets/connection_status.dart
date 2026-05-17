import 'package:flutter/material.dart';

/// Thin status bar showing connection state and streaming indicator.
class ConnectionStatus extends StatelessWidget {
  final String status;
  final bool isStreaming;

  const ConnectionStatus({
    super.key,
    required this.status,
    required this.isStreaming,
  });

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      color: colorScheme.surfaceContainerHighest.withOpacity(0.5),
      child: Row(
        children: [
          // Status dot
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: isStreaming ? Colors.amber : Colors.green,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            status.isNotEmpty ? status : (isStreaming ? 'Processing' : 'Ready'),
            style: TextStyle(
              fontSize: 11,
              color: colorScheme.onSurfaceVariant,
            ),
          ),
          if (isStreaming) ...[
            const SizedBox(width: 8),
            const SizedBox(
              width: 12,
              height: 12,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ],
        ],
      ),
    );
  }
}
