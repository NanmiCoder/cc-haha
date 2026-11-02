import SwiftUI

struct RefChurnView: View {
    @State private var filtered = false
    @State private var alpha = "Alpha"
    @State private var beta = "Beta"
    @State private var stable = "Stable value"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button(filtered ? "Restore rows" : "Filter rows") {
                filtered.toggle()
            }
            .accessibilityIdentifier("filter-rows")

            VStack(alignment: .leading, spacing: 8) {
                if !filtered {
                    TextField("", text: $alpha)
                        .accessibilityIdentifier("shared-title")
                }
                TextField("", text: $beta)
                    .accessibilityIdentifier("shared-title")
            }
            .frame(width: 300, height: 80, alignment: .topLeading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Changing collection")

            TextField("Stable editor", text: $stable)
                .accessibilityIdentifier("stable-editor")
                .accessibilityLabel("Stable editor")
            Text("Alpha stored: \(alpha)")
            Text("Beta stored: \(beta)")
            Text("Stable stored: \(stable)")
        }
        .padding(24)
        .frame(width: 380, height: 300)
    }
}
