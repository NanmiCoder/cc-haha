/// JPush (极光推送) integration for push notifications.
///
/// Uses jpush_flutter 3.x API: JPush.newJPush() → JPushFlutterInterface
///
/// Server side: JPush REST API v3 — JPUSH_APP_KEY / JPUSH_MASTER_SECRET
///
/// Android setup (automatic via plugin):
///   The plugin auto-registers. Just add your AppKey in the setup() call below.
///   No manual AndroidManifest changes needed.
///
/// iOS setup:
///   1. In Xcode: Runner → Capabilities → enable Push Notifications
///   2. The plugin handles the rest via CocoaPods

import 'dart:io' show Platform;
import 'package:flutter/material.dart';
import 'package:jpush_flutter/jpush_flutter.dart';
import 'package:jpush_flutter/jpush_interface.dart';
import '../services/api_client.dart';

class NotificationService {
  final ApiClient _api;
  late final dynamic _jpush; // JPushFlutterInterface — not exported, use dynamic

  String? _registrationId;

  NotificationService({required ApiClient api}) : _api = api;

  bool get hasRegistrationId => _registrationId != null;
  String? get registrationId => _registrationId;

  // ─── Callbacks ────────────────────────────────────────────────────────

  void Function(String sessionId, String? requestId, String? toolName)?
      onPermissionRequestTap;

  void Function(String? taskId)? onTaskCompleteTap;

  // ─── Initialization ───────────────────────────────────────────────────

  Future<void> init({
    required String appKey,
    bool isProduction = false,
    String channel = 'developer',
  }) async {
    _jpush = JPush.newJPush();

    // Initialize JPush
    _jpush.setup(
      appKey: appKey,
      production: isProduction,
      channel: channel,
      debug: !isProduction,
    );

    // Register event handlers
    _jpush.addEventHandler(
      onReceiveNotification: _onReceiveNotification,
      onOpenNotification: _onOpenNotification,
      onReceiveMessage: _onReceiveMessage,
    );

    // iOS: request push permission
    if (Platform.isIOS) {
      _jpush.applyPushAuthority(
        const NotificationSettingsIOS(sound: true, alert: true, badge: true),
      );
    }

    // Get registration ID and register with server
    try {
      final rid = await _jpush.getRegistrationID();
      if (rid.isNotEmpty) {
        _registrationId = rid;
        debugPrint('[haha] JPush registration ID: $rid');
        await _registerWithServer();
      }
    } catch (e) {
      debugPrint('[haha] Failed to get JPush registration ID: $e');
    }

    // Set badge to 0 on start
    try {
      await _jpush.setBadge(0);
    } catch (_) {}
  }

  // ─── Server registration ──────────────────────────────────────────────

  Future<void> _registerWithServer() async {
    if (_registrationId == null || _registrationId!.isEmpty) return;

    try {
      await _api.registerDevice(
        deviceToken: _registrationId!,
        platform: Platform.isIOS ? 'ios' : 'android',
      );
      debugPrint('[haha] JPush device registered with server');
    } catch (e) {
      debugPrint('[haha] Failed to register JPush device with server: $e');
    }
  }

  Future<void> unregister() async {
    if (_registrationId == null) return;

    try {
      await _api.unregisterDevice(deviceToken: _registrationId!);
      debugPrint('[haha] JPush device unregistered');
    } catch (e) {
      debugPrint('[haha] Failed to unregister JPush device: $e');
    }
  }

  // ─── Notification event handlers ──────────────────────────────────────

  /// Foreground notification (app is open → notification arrives).
  void _onReceiveNotification(Map<String, dynamic>? message) {
    if (message == null) return;
    debugPrint('[haha] Foreground notification: $message');

    final extras = message['extras'] as Map<String, dynamic>?;
    if (extras != null) _handleNotificationData(extras);
  }

  /// User tapped notification (app brought to foreground).
  void _onOpenNotification(Map<String, dynamic>? message) {
    if (message == null) return;
    debugPrint('[haha] Notification opened: $message');

    final extras = message['extras'] as Map<String, dynamic>?;
    if (extras != null) {
      Future.delayed(const Duration(milliseconds: 500), () {
        _handleNotificationData(extras);
      });
    }
  }

  /// Custom/passthrough message.
  void _onReceiveMessage(Map<String, dynamic>? message) {
    if (message == null) return;
    debugPrint('[haha] Custom message: $message');
    _handleNotificationData(message);
  }

  void _handleNotificationData(Map<String, dynamic> data) {
    final type = data['type'] as String?;
    final sessionId = data['sessionId'] as String?;

    switch (type) {
      case 'permission_request':
        onPermissionRequestTap?.call(
          sessionId ?? '',
          data['requestId'] as String?,
          data['toolName'] as String?,
        );
        break;

      case 'task_complete':
        onTaskCompleteTap?.call(data['taskId'] as String?);
        break;
    }
  }
}
