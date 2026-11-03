import SwiftUI

// A deterministic, deliberately *diverse* accessibility surface for
// agent-desktop end-to-end tests. The goal is to mirror how real macOS apps
// vary — refs assigned to some elements and not others, state exposed as a
// value here and as content there, draggable things that are not buttons,
// nested tables and outlines, sheets and popovers and menus — so the CLI is
// exercised against the real spread, not a happy path. This fixture is never
// tuned to make a command pass; when a command fails against a realistic
// pattern here, that is a finding about the CLI.
//
// Verification principle: interactive controls write their result into a
// StatusReadout whose live state is the accessibility *value*, so the harness
// reads the real outcome instead of trusting a command's self-report.


struct ContentView: View {
    // interaction
    @State private var clickStatus = "idle"
    @State private var clickCount = 0
    @State private var doubleStatus = "idle"
    @State private var tripleStatus = "idle"
    @State private var rightStatus = "idle"
    @State private var hoverStatus = "idle"
    @State private var twinStatus = "idle"
    // text
    @State private var textValue = ""
    @State private var secureValue = ""
    @State private var multilineValue = "line one\nline two"
    // state controls
    @State private var toggleOn = false
    @State private var pickerChoice = "Alpha"
    @State private var radioChoice = "One"
    @State private var disclosureExpanded = false
    @State private var tabSelection = 0
    // collections
    @State private var tableSelection: Int?
    // async / dynamic
    @State private var delayedEnabled = false
    @State private var delayedText = "waiting"
    @State private var delayedActionCount = 0
    @State private var removableVisible = true
    @State private var appearedText = ""
    // drag
    @State private var dropStatus = "empty"
    @State private var rowDropStatus = "empty"
    @State private var dragCanvasResult = "idle"
    // native AppKit controls (genuinely AX-settable, unlike SwiftUI's)
    @State private var nativeSliderValue = 0.0
    @State private var nativeStepperValue = 0.0
    // surfaces
    @State private var showSheet = false
    @State private var showPopover = false
    @State private var sheetStatus = "idle"
    @State private var sheetFieldValue = ""

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 8) {
                Text("AgentDesk Fixture")
                    .font(.title2)
                    .accessibilityLabel("fixture-title")
                row1
                row2
                row3
            }
            .padding(10)
        }
        .frame(minWidth: 980, minHeight: 720)
        .sheet(isPresented: $showSheet) { sheetContent }
    }

    private var row1: some View {
        HStack(alignment: .top, spacing: 12) {
            clicksCard
            textCard
            stateCard
        }
    }

    private var row2: some View {
        HStack(alignment: .top, spacing: 12) {
            choiceCard
            collectionsCard
            asyncCard
        }
    }

    private var row3: some View {
        HStack(alignment: .top, spacing: 12) {
            dragCard
            surfacesCard
            ScrollCard()
        }
    }

    // MARK: clicks / mouse

    private var clicksCard: some View {
        Card(title: "Clicks & Mouse") {
            Button("Primary Action") { clickCount += 1; clickStatus = "click-\(clickCount)" }
                .accessibilityLabel("primary-button")
            StatusReadout(name: "click-status", value: clickStatus)

            Button("Double Target") { }
                .accessibilityLabel("double-target")
                .simultaneousGesture(TapGesture(count: 2).onEnded { doubleStatus = "double-clicked" })
            StatusReadout(name: "double-status", value: doubleStatus)

            Button("Triple Target") { }
                .accessibilityLabel("triple-target")
                .simultaneousGesture(TapGesture(count: 3).onEnded { tripleStatus = "triple-clicked" })
            StatusReadout(name: "triple-status", value: tripleStatus)

            Button("Context Target") { }
                .accessibilityLabel("context-target")
                .contextMenu {
                    Button("Context Choice") { rightStatus = "context-picked" }
                        .accessibilityLabel("context-choice")
                }
            StatusReadout(name: "right-status", value: rightStatus)

            Button("Hover Target") { }
                .padding(6)
                .background(hoverStatus == "hovered" ? Color.yellow.opacity(0.4) : Color.clear)
                .accessibilityLabel("hover-target")
                .onHover { inside in hoverStatus = inside ? "hovered" : "idle" }
            StatusReadout(name: "hover-status", value: hoverStatus)

            /// Two controls sharing role and name. Each records a distinct
            /// effect so the harness can prove strict resolution acts on the
            /// addressed twin, never silently the other.
            Button("Twin Control") { twinStatus = "twin-a" }.accessibilityLabel("twin-control")
            Button("Twin Control") { twinStatus = "twin-b" }.accessibilityLabel("twin-control")
            StatusReadout(name: "twin-status", value: twinStatus)
        }
    }

    // MARK: text input variety

    private var textCard: some View {
        Card(title: "Text Input") {
            TextField("Text Input", text: $textValue)
                .accessibilityLabel("text-input")
            StatusReadout(name: "text-echo", value: textValue)

            SilentTextInput().frame(height: 22)

            SecureField("Secure Input", text: $secureValue)
                .accessibilityLabel("secure-input")
            StatusReadout(name: "secure-echo", value: secureValue.isEmpty ? "empty" : "set")

            TextEditor(text: $multilineValue)
                .frame(height: 60)
                .accessibilityLabel("multiline-input")

            Link("Example Link", destination: URL(string: "https://example.com")!)
                .accessibilityLabel("example-link")
        }
    }

    // MARK: toggles / sliders / steppers / disclosure

    private var stateCard: some View {
        Card(title: "State Controls") {
            Toggle("Toggle Box", isOn: $toggleOn).accessibilityLabel("toggle-box")
            StatusReadout(name: "toggle-status", value: toggleOn ? "on" : "off")

            // Native AppKit slider and stepper: unlike SwiftUI's, these expose a
            // working AX value/increment interface, so set-value can drive them.
            // The harness-facing labels (value-slider/value-stepper) live on the
            // NSViews themselves — the AX-actionable elements — so exactly one
            // label source exists regardless of how SwiftUI wraps them.
            NativeSlider(value: $nativeSliderValue).frame(width: 180, height: 20)
            StatusReadout(name: "slider-status", value: String(Int(nativeSliderValue)))
            NativeStepper(value: $nativeStepperValue)
            StatusReadout(name: "stepper-status", value: String(Int(nativeStepperValue)))

            DisclosureGroup("Disclosure Section", isExpanded: $disclosureExpanded) {
                Text("Disclosed Content").accessibilityLabel("disclosed-content")
            }
            .accessibilityLabel("disclosure-section")
        }
    }

    // MARK: pickers / radios / tabs

    private var choiceCard: some View {
        Card(title: "Choices") {
            Picker("Option Picker", selection: $pickerChoice) {
                Text("Alpha").tag("Alpha")
                Text("Beta").tag("Beta")
                Text("Gamma").tag("Gamma")
            }
            .accessibilityLabel("option-picker")
            .accessibilityIdentifier("option-picker")
            StatusReadout(name: "picker-status", value: pickerChoice)

            Picker("Radio Group", selection: $radioChoice) {
                Text("One").tag("One")
                Text("Two").tag("Two")
                Text("Three").tag("Three")
            }
            .pickerStyle(.radioGroup)
            .accessibilityLabel("radio-group")
            StatusReadout(name: "radio-status", value: radioChoice)

            TabView(selection: $tabSelection) {
                Text("Tab One Body").accessibilityLabel("tab-one-body").tabItem { Text("Tab One") }.tag(0)
                Text("Tab Two Body").accessibilityLabel("tab-two-body").tabItem { Text("Tab Two") }.tag(1)
            }
            .frame(height: 90)
            .accessibilityLabel("tab-view")
            StatusReadout(name: "tab-status", value: String(tabSelection))
        }
    }

    // MARK: table / outline

    private var collectionsCard: some View {
        Card(title: "Collections") {
            List(selection: $tableSelection) {
                ForEach(1...6, id: \.self) { i in
                    Text("List Item \(i)").accessibilityLabel("list-item-\(i)").tag(i)
                }
            }
            .frame(height: 120)
            .accessibilityLabel("item-list")
            StatusReadout(name: "list-selection", value: tableSelection.map(String.init) ?? "none")

            DisclosureGroup("Outline Parent") {
                Text("Outline Child A").accessibilityLabel("outline-child-a")
                Text("Outline Child B").accessibilityLabel("outline-child-b")
            }
            .accessibilityLabel("outline-parent")
        }
    }

    // MARK: async / dynamic

    private var asyncCard: some View {
        AsyncFixtureCard(
            delayedEnabled: $delayedEnabled,
            delayedText: $delayedText,
            delayedActionCount: $delayedActionCount,
            appearedText: $appearedText,
            removableVisible: $removableVisible
        )
    }

    // MARK: drag (interactive row + non-interactive image)

    private var dragCard: some View {
        Card(title: "Drag & Drop") {
            // Drag the canvas from one point to another within itself: a
            // source-tracked gesture, which synthetic mouse events can drive.
            // Its harness label lives on the NSView itself (DragCanvasView),
            // keeping exactly one AX label source.
            DragCanvas(result: $dragCanvasResult)
                .frame(width: 200, height: 80)
                .background(Color.purple.opacity(0.12))
            StatusReadout(name: "drag-canvas-status", value: dragCanvasResult)
            // A non-interactive image drag source: realistic (file icons, custom
            // views) and intentionally NOT a button, so the CLI is tested on a
            // ref-less draggable.
            Image(systemName: "doc.fill")
                .resizable()
                .frame(width: 44, height: 44)
                .accessibilityLabel("image-drag-source")
                .onDrag { NSItemProvider(object: "image-item" as NSString) }

            // An interactive row drag source (ref-able), the common case.
            Text("Row Drag Source")
                .padding(6)
                .background(Color.blue.opacity(0.15))
                .accessibilityLabel("row-drag-source")
                .accessibilityAddTraits(.isButton)
                .onDrag { NSItemProvider(object: "row-item" as NSString) }

            // The drop-status readouts are siblings (not overlays) so the
            // accessibilityLabel on the drop rectangle does not absorb them and
            // the harness can read the drop result independently.
            RoundedRectangle(cornerRadius: 8)
                .stroke(dropStatus == "dropped" ? Color.green : Color.gray)
                .frame(width: 200, height: 60)
                .accessibilityLabel("drop-zone")
                .onDrop(of: ["public.text"], isTargeted: nil) { _ in dropStatus = "dropped"; return true }
            StatusReadout(name: "drop-status", value: dropStatus)

            RoundedRectangle(cornerRadius: 8)
                .stroke(rowDropStatus == "dropped" ? Color.green : Color.gray)
                .frame(width: 200, height: 60)
                .accessibilityLabel("row-drop-zone")
                .onDrop(of: ["public.text"], isTargeted: nil) { _ in rowDropStatus = "dropped"; return true }
            StatusReadout(name: "row-drop-status", value: rowDropStatus)
        }
    }

    // MARK: surfaces (sheet / popover)

    private var surfacesCard: some View {
        Card(title: "Surfaces") {
            Button("Open Sheet") { showSheet = true }.accessibilityLabel("open-sheet")
            StatusReadout(name: "sheet-status", value: sheetStatus)

            Button("Open Popover") { showPopover = true }
                .accessibilityLabel("open-popover")
                .popover(isPresented: $showPopover) {
                    VStack {
                        Text("Popover Body").accessibilityLabel("popover-body")
                        Button("Close Popover") { showPopover = false }.accessibilityLabel("close-popover")
                    }
                    .padding()
                }
        }
    }

    private var sheetContent: some View {
        VStack(spacing: 12) {
            Text("Sheet Title").font(.headline).accessibilityLabel("sheet-title")
            TextField("Sheet Field", text: $sheetFieldValue).accessibilityLabel("sheet-field").frame(width: 200)
            Button("Confirm Sheet") { sheetStatus = "confirmed"; showSheet = false }
                .accessibilityLabel("confirm-sheet")
            Button("Cancel Sheet") { sheetStatus = "cancelled"; showSheet = false }
                .accessibilityLabel("cancel-sheet")
        }
        .padding(24)
        .frame(width: 320, height: 200)
    }

}

@main
struct AgentDeskFixtureApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        WindowGroup("AgentDesk Fixture") {
            if ProcessInfo.processInfo.environment["AGENT_DESKTOP_FIXTURE_REF_CHURN"] == "1" {
                RefChurnView()
            } else {
                ContentView()
            }
        }
            .commands {
                // Custom top menu so the harness can verify the app menu bar is
                // enumerable via `snapshot --surface menubar`. (SwiftUI
                // CommandMenu items accept AXPress but do not route to their
                // action closure — a SwiftUI limitation, like its Slider; native
                // AppKit menu items fire via AX.)
                CommandMenu("Fixture") {
                    Button("Fire Menu Item") {}.accessibilityLabel("menu-fire-item")
                }
            }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var isBackgroundFixture: Bool {
        ProcessInfo.processInfo.environment["AGENT_DESKTOP_FIXTURE_NO_ACTIVATE"] == "1"
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        if isBackgroundFixture {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if isBackgroundFixture {
            return
        }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: false)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
