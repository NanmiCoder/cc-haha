/// Session model — mirrors the server session API response.
class Session {
  final String id;
  final String title;
  final String workDir;
  final DateTime createdAt;
  final DateTime updatedAt;
  final int messageCount;

  Session({
    required this.id,
    required this.title,
    required this.workDir,
    required this.createdAt,
    required this.updatedAt,
    this.messageCount = 0,
  });

  factory Session.fromJson(Map<String, dynamic> json) {
    return Session(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? 'Untitled',
      workDir: json['workDir'] as String? ?? '',
      createdAt: _parseDate(json['createdAt']),
      updatedAt: _parseDate(json['updatedAt']),
      messageCount: json['messageCount'] as int? ?? 0,
    );
  }

  static DateTime _parseDate(dynamic val) {
    if (val is String) return DateTime.tryParse(val) ?? DateTime.now();
    return DateTime.now();
  }
}
