import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:haha_mobile/main.dart';
import 'package:haha_mobile/providers/app_state.dart';

void main() {
  testWidgets('App renders connect screen when not configured',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => AppState(),
        child: const HahaApp(),
      ),
    );
    await tester.pump();

    // Should show the connect screen
    expect(find.text('Connect to haha'), findsOneWidget);
  });
}
