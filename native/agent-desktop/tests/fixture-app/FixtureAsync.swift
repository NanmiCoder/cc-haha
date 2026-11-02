import SwiftUI

struct AsyncFixtureCard: View {
    @Binding var delayedEnabled: Bool
    @Binding var delayedText: String
    @Binding var delayedActionCount: Int
    @Binding var appearedText: String
    @Binding var removableVisible: Bool

    var body: some View {
        Card(title: "Async & Dynamic") {
            Button("Enable Later") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    delayedEnabled = true
                    delayedText = "ready"
                }
            }
            .accessibilityLabel("enable-later")
            .accessibilityIdentifier("enable-later")
            Button("Delayed Button") { delayedActionCount += 1 }
                .disabled(!delayedEnabled)
                .accessibilityLabel("delayed-button")
                .accessibilityIdentifier("delayed-button")
            StatusReadout(name: "delayed-text", value: delayedText)
            StatusReadout(name: "delayed-action-status", value: String(delayedActionCount))

            Button("Reset Delayed Button") {
                delayedEnabled = false
                delayedText = "waiting"
                delayedActionCount = 0
            }
            .accessibilityLabel("reset-delayed-button")
            .accessibilityIdentifier("reset-delayed-button")

            Button("Permanently Disabled") { delayedActionCount += 100 }
                .disabled(true)
                .accessibilityLabel("permanently-disabled")

            ZeroBoundsButton().frame(width: 1, height: 1)

            Button("Open Duplicate Windows") {
                DuplicateWindowController.shared.openWindows()
            }
            .accessibilityLabel("open-duplicate-windows")
            Button("Close Duplicate Windows") {
                DuplicateWindowController.shared.closeWindows()
            }
            .accessibilityLabel("close-duplicate-windows")

            Button("Appear Later") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    appearedText = "appeared-text"
                }
            }
            .accessibilityLabel("appear-later")
            Button("Reset Appeared Text") { appearedText = "" }
                .accessibilityLabel("reset-appeared-text")
            if !appearedText.isEmpty {
                Text(appearedText).accessibilityLabel("appeared-text")
            }

            if removableVisible {
                Button("Removable Row") {}.accessibilityLabel("removable-row")
            }
            Button("Remove Row") { removableVisible = false }.accessibilityLabel("remove-row")
            Button("Reset Removable Row") { removableVisible = true }
                .accessibilityLabel("reset-removable")
        }
    }
}
