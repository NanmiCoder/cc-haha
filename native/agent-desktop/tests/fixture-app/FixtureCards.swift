import SwiftUI

// Overflow card extracted from AgentDeskFixture.swift to keep that file under
// the 400-LOC limit. All accessibility labels are preserved byte-for-byte so
// the E2E harness (tests/e2e/run.sh) continues to resolve them unchanged.
// The build compiles every .swift file in this directory as one module.

struct ScrollCard: View {
    @State private var scrollOffset = 0

    var body: some View {
        Card(title: "Scroll") {
            StatusReadout(name: "scroll-offset", value: String(scrollOffset))
            ScrollView {
                VStack(alignment: .leading) {
                    GeometryReader { geo in
                        Color.clear.preference(
                            key: ScrollOffsetKey.self,
                            value: geo.frame(in: .named("scroll-space")).minY)
                    }
                    .frame(height: 0)
                    ForEach(1...60, id: \.self) { i in
                        Text("Scroll Row \(i)").accessibilityLabel("scroll-row-\(i)")
                    }
                }
            }
            .coordinateSpace(name: "scroll-space")
            .onPreferenceChange(ScrollOffsetKey.self) { scrollOffset = Int(-$0) }
            .frame(width: 220, height: 160)
            .accessibilityLabel("scroll-area")
        }
    }
}
