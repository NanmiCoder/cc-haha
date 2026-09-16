import Carbon.HIToolbox
import CoreGraphics
import XCTest
@testable import cc_haha_computer_use

/// Expectations come from events received by a disposable AppKit app using
/// the installed official macOS App.pressKey implementation, not X11 docs.
final class KeyMappingParityTests: XCTestCase {
    func testNamedNumberRowSymbolsMatchActualMacOSReceiverKeys() throws {
        let names = "exclam at numbersign dollar percent asciicircum ampersand asterisk parenleft parenright"
        let chords = try KeyMapping.parse(names)
        XCTAssertEqual(chords.map(\.keyCode), [18, 19, 20, 21, 23, 22, 26, 28, 25, 29])
        XCTAssertEqual(chords.map(\.flags), Array(repeating: .maskShift, count: 10))
    }

    func testMacOSXKeysymModifierAliasesProduceTheReceivedFlags() throws {
        let cases: [(String, CGEventFlags)] = [
            ("Control_L", .maskControl), ("Control_R", .maskControl),
            ("Super_L", .maskCommand), ("Super_R", .maskCommand),
            ("Meta_L", .maskCommand), ("Meta_R", .maskCommand),
            ("Shift_L", .maskShift), ("Shift_R", .maskShift),
            ("Alt_L", .maskAlternate), ("Alt_R", .maskAlternate),
        ]
        for (modifier, flags) in cases {
            let chord = try XCTUnwrap(KeyMapping.parse("\(modifier)+a").first)
            XCTAssertEqual(chord.keyCode, try KeyMapping.keyCode(for: "a"), modifier)
            XCTAssertEqual(chord.flags, flags, modifier)
        }
        XCTAssertEqual(try KeyMapping.parse("Control_L+a Super_R+b").map(\.flags), [.maskControl, .maskCommand])
    }

    func testDeleteAndBackSpaceRemainDifferentPhysicalKeys() throws {
        XCTAssertEqual(try KeyMapping.parse("Delete").first?.keyCode, CGKeyCode(kVK_ForwardDelete))
        XCTAssertEqual(try KeyMapping.parse("BackSpace").first?.keyCode, CGKeyCode(kVK_Delete))
    }

    func testUppercaseAndNamedShiftedGlyphPreserveRequiredModifier() throws {
        let uppercase = try XCTUnwrap(KeyMapping.parse("A").first)
        XCTAssertEqual(uppercase.keyCode, try KeyMapping.keyCode(for: "a"))
        XCTAssertEqual(uppercase.flags, .maskShift)
        let punctuation = try XCTUnwrap(KeyMapping.parse("question").first)
        XCTAssertEqual(punctuation.keyCode, CGKeyCode(kVK_ANSI_Slash))
        XCTAssertEqual(punctuation.flags, .maskShift)
        XCTAssertEqual(try KeyMapping.parse("Control_R+question").first?.flags, [.maskControl, .maskShift])
    }

    func testNewCommandAliasesCannotBypassSystemShortcutGrant() throws {
        for sequence in ["Super_L+q", "Super_R+Tab", "Meta_L+space", "Control_R+Super_R+q"] {
            XCTAssertTrue(try SystemKeyPolicy.requiresGrant(sequence), sequence)
            XCTAssertThrowsError(try SystemKeyPolicy.enforce(sequence: sequence, granted: false)) {
                XCTAssertEqual(($0 as? CUError)?.code, "grant_flag_required")
            }
        }
    }

    func testUnsupportedModifierOnlyAndMultipleKeyChordsStillReject() {
        for sequence in ["Control_L", "Hyper_L+k", "Control_L+a+b", "a+Control_L"] {
            XCTAssertThrowsError(try KeyMapping.parse(sequence), sequence)
        }
    }
}
