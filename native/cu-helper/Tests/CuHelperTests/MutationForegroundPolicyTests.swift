import XCTest
@testable import cc_haha_computer_use

final class MutationForegroundPolicyTests: XCTestCase {
    func testEverySemanticMutationRequiresForegroundLease() {
        let mutations = [
            "click",
            "set_value",
            "select_text",
            "perform_secondary_action",
            "scroll",
            "type_text",
            "paste",
            "press_key",
            "drag",
        ]

        for command in mutations {
            XCTAssertTrue(
                CommandForegroundPolicy.requiresLease(command),
                "\(command) must reach its guarded input path instead of being rejected as bad_command"
            )
        }
    }

    func testEveryLegacyMutationRequiresForegroundLease() {
        let mutations = [
            "key",
            "hold_key",
            "type",
            "paste_clipboard",
            "mouse_down",
            "mouse_up",
        ]

        XCTAssertTrue(mutations.allSatisfy(CommandForegroundPolicy.requiresLease))
    }

    func testReadOnlyStateMovementOpenClipboardAndTeardownRemainExcluded() {
        let excluded = [
            "screenshot",
            "get_app_state",
            "list_apps",
            "move_mouse",
            "cursor_position",
            "open_app",
            "read_clipboard",
            "write_clipboard",
            "check_permissions",
            "release_all_held",
        ]

        XCTAssertTrue(excluded.allSatisfy { !CommandForegroundPolicy.requiresLease($0) })
    }
}
