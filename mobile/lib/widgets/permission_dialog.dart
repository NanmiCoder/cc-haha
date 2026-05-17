import 'package:flutter/material.dart';

/// A styled dialog for tool permission requests (shown when not using the inline
/// permission card in the chat).
class PermissionDialog extends StatelessWidget {
  final String toolName;
  final String? description;
  final String? inputPreview;
  final void Function() onApprove;
  final void Function() onDeny;

  const PermissionDialog({
    super.key,
    required this.toolName,
    this.description,
    this.inputPreview,
    required this.onApprove,
    required this.onDeny,
  });

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return AlertDialog(
      title: Row(
        children: [
          Icon(Icons.security, color: Colors.orange.shade700),
          const SizedBox(width: 8),
          const Text('Permission Required'),
        ],
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'haha wants to use:',
            style: TextStyle(color: colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: 4),
          Text(
            toolName,
            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
          ),
          if (description != null) ...[
            const SizedBox(height: 12),
            Text(
              description!,
              style: TextStyle(
                color: colorScheme.onSurfaceVariant,
                fontSize: 13,
              ),
            ),
          ],
          if (inputPreview != null && inputPreview!.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(8),
              ),
              child: SelectableText(
                inputPreview!,
                style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
                maxLines: 8,
              ),
            ),
          ],
        ],
      ),
      actions: [
        OutlinedButton.icon(
          onPressed: onDeny,
          icon: const Icon(Icons.close, size: 18),
          label: const Text('Deny'),
          style: OutlinedButton.styleFrom(
            foregroundColor: Colors.red.shade700,
          ),
        ),
        FilledButton.icon(
          onPressed: onApprove,
          icon: const Icon(Icons.check, size: 18),
          label: const Text('Approve'),
          style: FilledButton.styleFrom(
            backgroundColor: Colors.green.shade600,
          ),
        ),
      ],
    );
  }
}
