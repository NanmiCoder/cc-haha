import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import '../models/session.dart';
import '../providers/app_state.dart';
import 'chat_screen.dart';

/// Session list screen — shows all sessions, create/delete, tap to open chat.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<AppState>().loadSessions();
    });
  }

  @override
  Widget build(BuildContext context) {
    final appState = context.watch<AppState>();
    final colorScheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(
        title: const Text('haha'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Disconnect',
            onPressed: () => appState.disconnect(),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => appState.loadSessions(),
        child: appState.sessionsLoading
            ? const Center(child: CircularProgressIndicator())
            : appState.sessions.isEmpty
                ? ListView(
                    children: [
                      SizedBox(
                        height: MediaQuery.of(context).size.height * 0.6,
                        child: Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.chat_bubble_outline,
                                  size: 64, color: colorScheme.onSurfaceVariant),
                              const SizedBox(height: 16),
                              Text(
                                'No sessions yet',
                                style: Theme.of(context)
                                    .textTheme
                                    .titleMedium
                                    ?.copyWith(
                                      color: colorScheme.onSurfaceVariant,
                                    ),
                              ),
                              const SizedBox(height: 8),
                              Text(
                                'Tap + to create a new session',
                                style: Theme.of(context)
                                    .textTheme
                                    .bodySmall
                                    ?.copyWith(
                                      color: colorScheme.onSurfaceVariant,
                                    ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  )
                : ListView.builder(
                    itemCount: appState.sessions.length,
                    itemBuilder: (context, index) {
                      final session = appState.sessions[index];
                      return _SessionTile(
                        session: session,
                        onTap: () async {
                          await appState.openSession(session.id, workDir: session.workDir);
                          if (mounted) {
                            Navigator.of(context).push(
                              MaterialPageRoute(
                                builder: (_) => const ChatScreen(),
                              ),
                            );
                          }
                        },
                        onDelete: () =>
                            _confirmDelete(context, appState, session),
                      );
                    },
                  ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _showCreateDialog(context, appState),
        icon: const Icon(Icons.add),
        label: const Text('New Session'),
      ),
    );
  }

  void _showCreateDialog(BuildContext context, AppState appState) {
    final workDirController = TextEditingController(text: '/idw');
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New Session'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Choose a working directory for this session:'),
            const SizedBox(height: 12),
            TextField(
              controller: workDirController,
              decoration: const InputDecoration(
                labelText: 'Work Directory',
                hintText: '/idw',
                prefixIcon: Icon(Icons.folder),
                border: OutlineInputBorder(),
              ),
              textInputAction: TextInputAction.done,
              onSubmitted: (v) async {
                Navigator.of(ctx).pop();
                await _createAndOpen(appState, v.trim());
              },
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () async {
              Navigator.of(ctx).pop();
              await _createAndOpen(appState, workDirController.text.trim());
            },
            child: const Text('Create'),
          ),
          FilledButton(
            onPressed: () async {
              Navigator.of(ctx).pop();
              await _createAndOpen(appState, '/idw');
            },
            child: const Text('Default (/idw)'),
          ),
        ],
      ),
    );
  }

  Future<void> _createAndOpen(AppState appState, String workDir) async {
    final session = await appState.createSession(workDir: workDir);
    if (session != null && mounted) {
      await appState.openSession(session.id, workDir: session.workDir);
      if (mounted) {
        Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const ChatScreen()),
        );
      }
    }
  }

  void _confirmDelete(
    BuildContext context,
    AppState appState,
    Session session,
  ) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Session?'),
        content: Text('This will permanently delete "${session.title}".'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              appState.deleteSession(session.id);
            },
            style: FilledButton.styleFrom(
              backgroundColor: Colors.red,
            ),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
  }
}

class _SessionTile extends StatelessWidget {
  final Session session;
  final VoidCallback onTap;
  final VoidCallback onDelete;

  const _SessionTile({
    required this.session,
    required this.onTap,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final dateFormat = DateFormat('MMM d, HH:mm');
    final colorScheme = Theme.of(context).colorScheme;

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: ListTile(
        title: Text(
          session.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          '${dateFormat.format(session.updatedAt)} · ${session.workDir.split('/').last}',
          style: TextStyle(color: colorScheme.onSurfaceVariant, fontSize: 12),
        ),
        trailing: IconButton(
          icon: const Icon(Icons.delete_outline, size: 20),
          onPressed: onDelete,
        ),
        onTap: onTap,
      ),
    );
  }
}
