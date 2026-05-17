import 'package:flutter/material.dart';

/// Thin status bar showing connection state, model, and project info.
class ConnectionStatus extends StatelessWidget {
  final String status;
  final bool isStreaming;
  final String? model;
  final String? workDir;

  const ConnectionStatus({
    super.key,
    required this.status,
    required this.isStreaming,
    this.model,
    this.workDir,
  });

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
        border: Border(
          bottom: BorderSide(color: colorScheme.outlineVariant.withValues(alpha: 0.3)),
        ),
      ),
      child: Row(
        children: [
          // Status dot
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: isStreaming ? Colors.amber : Colors.green,
            ),
          ),
          const SizedBox(width: 6),
          Text(
            status.isNotEmpty ? status : (isStreaming ? 'Processing' : 'Ready'),
            style: TextStyle(fontSize: 11, color: colorScheme.onSurfaceVariant),
          ),
          if (isStreaming) ...[
            const SizedBox(width: 6),
            SizedBox(
              width: 10,
              height: 10,
              child: CircularProgressIndicator(
                strokeWidth: 1.5,
                color: colorScheme.primary,
              ),
            ),
          ],
          const Spacer(),
          // Model / Workdir info
          if (workDir != null) ...[
            Icon(Icons.folder_outlined, size: 10, color: colorScheme.outline),
            const SizedBox(width: 3),
            Flexible(
              child: Text(
                workDir!.split('/').last,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 10, color: colorScheme.outline),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
