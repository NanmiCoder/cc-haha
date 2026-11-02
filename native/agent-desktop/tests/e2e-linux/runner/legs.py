from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Callable

TIER_NAMES = ("x11-openbox", "x11-mutter", "wayland")
MODE_NAMES = ("headless", "headed")
ORACLE_NAMES = ("atspi", "gsettings", "x11", "proc", "pixels", "clipboard", "dbus", "applog")
DISPOSITIONS = ("pass", "asserted-refusal", "owner-decision", "outstanding")

X11 = ("x11-openbox", "x11-mutter")
OPENBOX_ONLY = ("x11-openbox",)
MUTTER_ONLY = ("x11-mutter",)
WAYLAND_ONLY = ("wayland",)
ALL_TIERS = TIER_NAMES
HEADLESS = ("headless",)
HEADED = ("headed",)
BOTH_MODES = MODE_NAMES


@dataclass(frozen=True)
class Leg:
    id: str
    requirement: str
    target: str
    tiers: tuple[str, ...]
    modes: tuple[str, ...]
    oracles: tuple[str, ...]
    disposition: str
    reason: str = ""

    def __post_init__(self) -> None:
        if not self.requirement.strip():
            raise ValueError(f"leg {self.id} has no requirement")
        if not set(self.tiers) <= set(TIER_NAMES) or not self.tiers:
            raise ValueError(f"leg {self.id} names an unknown tier")
        if not set(self.modes) <= set(MODE_NAMES) or not self.modes:
            raise ValueError(f"leg {self.id} names an unknown mode")
        if not set(self.oracles) <= set(ORACLE_NAMES) or not self.oracles:
            raise ValueError(f"leg {self.id} names an unknown oracle")
        if self.disposition not in DISPOSITIONS:
            raise ValueError(f"leg {self.id} has an unknown disposition")
        if self.disposition != "pass" and not self.reason:
            raise ValueError(f"leg {self.id} needs a reason for its disposition")


REGISTRY: tuple[Leg, ...] = (
    Leg('ref_actions.expand', 'A ref expands the Calculator menu and reveals its children, then restores', 'Calculator', ('x11-openbox',), ('headless', 'headed'), ('atspi', 'x11'), 'pass', ''),
    Leg('ref_actions.collapse', 'A ref collapses the Calculator menu and hides its children, then restores', 'Calculator', ('x11-openbox',), ('headless', 'headed'), ('atspi', 'x11'), 'pass', ''),
    Leg('ref_actions.scroll', 'Ref scroll changes visible Settings rows, then restores', 'Settings', ('x11-openbox', 'x11-mutter'), ('headed',), ('atspi', 'x11'), 'pass', ''),
    Leg('ref_actions.scroll_headless_refusal', 'Headless ref scroll is refused without changing visible rows', 'Settings', ('x11-openbox',), ('headless',), ('atspi', 'x11'), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('ref_actions.scroll_to', 'Ref scroll-to reveals an offscreen control and restores the viewport', 'Settings', ('x11-openbox',), ('headless', 'headed'), ('atspi', 'x11'), 'pass', ''),
    Leg('ref_actions.focus', 'Ref focus changes the raw FOCUSED state and restores it', 'Qt window', ('x11-openbox',), ('headed',), ('atspi', 'x11'), 'pass', ''),
    Leg('ref_actions.focus_headless_refusal', 'Headless ref focus is refused without changing focus', 'Qt window', ('x11-openbox',), ('headless',), ('atspi', 'x11'), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('ref_actions.double_click', 'Ref double-click selects a document word and restores selection', 'Text Editor', ('x11-openbox', 'x11-mutter'), ('headed',), ('atspi', 'x11'), 'pass', ''),
    Leg('ref_actions.double_click_headless_refusal', 'Headless double-click is refused without selecting text', 'Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11'), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('ref_actions.triple_click', 'Ref triple-click selects a document line and restores selection', 'Text Editor', ('x11-openbox', 'x11-mutter'), ('headed',), ('atspi', 'x11'), 'pass', ''),
    Leg('ref_actions.triple_click_headless_refusal', 'Headless triple-click is refused without selecting text', 'Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11'), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('ref_actions.right_click', 'Ref right-click opens the raw context menu and restores it', 'Text Editor', ('x11-openbox', 'x11-mutter'), ('headless', 'headed'), ('atspi', 'x11'), 'pass', ''),
    Leg('ref_actions.hover', 'Ref hover exposes native status text and restores it', 'Qt window', ('x11-openbox', 'x11-mutter'), ('headed',), ('atspi', 'x11'), 'pass', ''),
    Leg('ref_actions.hover_headless_refusal', 'Headless ref hover is refused without exposing status text', 'Qt window', ('x11-openbox',), ('headless',), ('atspi', 'x11'), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('ref_actions.drag', 'Ref drag selects document text and restores selection', 'Text Editor', ('x11-openbox',), ('headed',), ('atspi', 'x11'), 'pass', ''),
    Leg('ref_actions.drag_headless_refusal', 'Headless ref drag is refused without selecting text', 'Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11'), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('capture.window_pixels_match_xwd', 'A window capture matches the pixels xwd reads', 'Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('pixels', 'x11'), 'pass', ''),
    Leg('gaps.event_surface-appeared_scoped_success', 'surface-appeared scoped success', 'Calculator About', ('x11-openbox',), ('headless',), ('atspi',), 'pass', ''),
    Leg('gaps.event_surface-appeared_scoped_quiet', 'surface-appeared scoped quiet', 'Calculator About', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('gaps.event_surface-appeared_unscoped_success', 'Unscoped surface-appeared is INVALID_ARGS with a showing About dialog', 'Calculator About', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'asserted-refusal', 'INVALID_ARGS: surface events require --app; raw surface state unchanged'),
    Leg('gaps.event_surface-appeared_unscoped_quiet', 'Unscoped surface-appeared is INVALID_ARGS without a dialog', 'Calculator About', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'asserted-refusal', 'INVALID_ARGS: surface events require --app; raw surface state unchanged'),
    Leg('gaps.event_surface-dismissed_scoped_success', 'surface-dismissed scoped success', 'Calculator About', ('x11-openbox',), ('headless',), ('atspi',), 'pass', ''),
    Leg('gaps.event_surface-dismissed_scoped_quiet', 'surface-dismissed scoped quiet', 'Calculator About', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('gaps.event_surface-dismissed_unscoped_success', 'Unscoped surface-dismissed is INVALID_ARGS with a showing About dialog', 'Calculator About', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'asserted-refusal', 'INVALID_ARGS: surface events require --app; raw surface state unchanged'),
    Leg('gaps.event_surface-dismissed_unscoped_quiet', 'Unscoped surface-dismissed is INVALID_ARGS without a dialog', 'Calculator About', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'asserted-refusal', 'INVALID_ARGS: surface events require --app; raw surface state unchanged'),
    Leg('gaps.gesture_gtk4_first_mouse-click', 'gtk4 first mouse-click with pointer and raw geometry/effect reads', 'gtk4', ('x11-openbox', 'x11-mutter'), ('headed',), ('x11', 'atspi', 'applog'), 'pass', ''),
    Leg('gaps.gesture_gtk4_second_mouse-click', 'gtk4 second mouse-click with pointer and raw geometry/effect reads', 'gtk4', ('x11-openbox',), ('headed',), ('x11', 'atspi', 'applog'), 'pass', ''),
    Leg('gaps.gesture_qt_first_mouse-click', 'qt first mouse-click with pointer and raw geometry/effect reads', 'qt', ('x11-openbox',), ('headed',), ('x11', 'atspi', 'applog'), 'pass', ''),
    Leg('gaps.event_window-opened_scoped_success', 'window-opened scoped success with independent restoration', 'Calculator and Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_window-opened_scoped_quiet', 'window-opened scoped quiet with independent restoration', 'Calculator and Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_window-opened_unscoped_success', 'window-opened unscoped success with independent restoration', 'Calculator and Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_window-closed_scoped_quiet', 'window-closed scoped quiet with independent restoration', 'Calculator and Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_window-closed_unscoped_quiet', 'window-closed unscoped quiet with independent restoration', 'Calculator and Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_app-launched_scoped_success', 'app-launched scoped success with independent restoration', 'Calculator and Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_app-launched_scoped_quiet', 'app-launched scoped quiet with independent restoration', 'Calculator and Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_app-launched_unscoped_success', 'app-launched unscoped success with independent restoration', 'Calculator and Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_app-launched_unscoped_quiet', 'app-launched unscoped quiet with independent restoration', 'Calculator and Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_app-terminated_scoped_success', 'app-terminated scoped success with independent restoration', 'Calculator and Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_app-terminated_scoped_quiet', 'app-terminated scoped quiet with independent restoration', 'Calculator and Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_app-terminated_unscoped_success', 'app-terminated unscoped success with independent restoration', 'Calculator and Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_app-terminated_unscoped_quiet', 'app-terminated unscoped quiet with independent restoration', 'Calculator and Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_focus-changed_scoped_success', 'focus-changed scoped success with independent restoration', 'Calculator and Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_focus-changed_scoped_quiet', 'focus-changed scoped quiet with independent restoration', 'Calculator and Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_focus-changed_unscoped_success', 'focus-changed unscoped success with independent restoration', 'Calculator and Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.event_focus-changed_unscoped_quiet', 'focus-changed unscoped quiet with independent restoration', 'Calculator and Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('gaps.timeout_explicit', 'disabled action uses explicit timeout without an effect', 'Calculator Undo', ('x11-openbox', 'x11-mutter'), ('headless', 'headed'), ('atspi',), 'asserted-refusal', 'permanently disabled Undo must refuse without changing text/state; zero timeout is one immediate ACTION_FAILED check'),
    Leg('gaps.timeout_short', 'disabled action uses short timeout without an effect', 'Calculator Undo', ('x11-openbox', 'x11-mutter'), ('headless', 'headed'), ('atspi',), 'asserted-refusal', 'permanently disabled Undo must refuse without changing text/state; zero timeout is one immediate ACTION_FAILED check'),
    Leg('gaps.timeout_zero', 'disabled action uses zero timeout without an effect', 'Calculator Undo', ('x11-openbox', 'x11-mutter'), ('headless', 'headed'), ('atspi',), 'asserted-refusal', 'permanently disabled Undo must refuse without changing text/state; zero timeout is one immediate ACTION_FAILED check'),
    Leg('gaps.value_write_preserves_active_window', 'a background value write preserves the active window and pointer', 'Settings behind Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('gsettings', 'x11'), 'pass', ''),
    Leg('gaps.display_capture', 'display pixels match XWD', 'Calculator', ('x11-openbox',), ('headless',), ('pixels', 'x11'), 'pass', ''),
    Leg('gaps.mutter_display_capture_refused', 'display capture asserts the compositing refusal', 'Calculator', ('x11-mutter',), ('headless',), ('pixels', 'x11'), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('gaps.wayland_window_capture_refused', 'Wayland window capture fails closed without changing the app', 'Calculator', ('wayland',), ('headless',), ('atspi',), 'asserted-refusal', 'Wayland has no window-position capture route'),
    Leg('gaps.mutter_move', 'Mutter move has an independently restored effect', 'Calculator', ('x11-mutter',), ('headless',), ('x11', 'proc'), 'pass', ''),
    Leg('gaps.mutter_resize', 'Mutter resize has an independently restored effect', 'Calculator', ('x11-mutter',), ('headless',), ('x11', 'proc'), 'pass', ''),
    Leg('gaps.mutter_minimize_restore', 'Mutter minimize_restore has an independently restored effect', 'Calculator', ('x11-mutter',), ('headless',), ('x11', 'proc'), 'pass', ''),
    Leg('gaps.mutter_window_operation_refusals', 'missing-window move/resize/minimize report not_delivered and leave the real window unchanged', 'Calculator', ('x11-mutter',), ('headless',), ('x11',), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('gaps.mutter_qt_headless_click_logged_once', 'Qt on Mutter headless_click_logged_once', 'Qt window', ('x11-mutter',), ('headless',), ('applog',), 'pass', ''),
    Leg('modal.calculator_about_blocks_parent', 'About blocks a ref action on its parent', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headed',), ('atspi', 'x11'), 'asserted-refusal', 'ACTION_FAILED, blocked_by_modal_dialog; parent effect unchanged'),
    Leg('observation.qualified_refs_survive_snapshots', 'A qualified ref still resolves after unrelated snapshots', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('observation.stale_ref_after_app_killed', 'A ref held across an app kill answers STALE_REF or ELEMENT_NOT_FOUND', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('observation.stale_ref_after_ui_change', 'A ref to a menu item whose menu closed answers STALE_REF with a refresh-snapshot recovery, not_delivered and exit 1 while the app stays alive, then a fresh snapshot mints a new ref', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'proc'), 'asserted-refusal', 'the stale click is refused with STALE_REF before any input; display and owned processes unchanged'),
    Leg('observation.selector_wait_resolves', 'A selector wait returns once the element appears', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('observation.enabled_state_canonical_and_raw', 'is enabled reads canonical enabled while the raw SENSITIVE bit holds', 'Calculator', ('x11-openbox',), ('headless',), ('atspi',), 'pass', ''),
    Leg('observation.session_namespace_isolation', 'A snapshot taken in one session is not visible from another', 'Calculator', ('x11-openbox',), ('headless',), ('atspi',), 'pass', ''),
    Leg('observation.trace_segment_written', 'A traced command writes one trace segment under the selected session', 'Calculator', ('x11-openbox',), ('headless',), ('proc',), 'pass', ''),
    Leg('state.terminal_copy_follows_selection', 'Copy enables and disables with a text selection', 'Terminal', ('x11-openbox',), ('headless',), ('atspi',), 'pass', ''),
    Leg('state.text_editor_semantic_type', 'The semantic type path writes the typed text into the document', 'Text Editor', ('x11-openbox',), ('headless', 'headed'), ('atspi',), 'pass', ''),
    Leg('values.hot_corner_flip_restore', 'Hot Corner flips, the key confirms it, and it restores', 'Settings', ('x11-openbox',), ('headless', 'headed'), ('gsettings',), 'pass', ''),
    Leg('values.pointer_speed_commit', 'Pointer Speed takes a value the key confirms after panel reopen', 'Settings', ('x11-openbox',), ('headless', 'headed'), ('gsettings',), 'pass', ''),
    Leg('values.terminal_read_only_flip', 'The Read-Only check item flips and restores', 'Terminal', ('x11-openbox', 'x11-mutter'), ('headless', 'headed'), ('atspi',), 'pass', ''),
    Leg('select.screen_blank_value', 'Screen Blank takes a new value the idle-delay key confirms', 'Settings', ('x11-openbox', 'x11-mutter'), ('headless', 'headed'), ('gsettings',), 'pass', ''),
    Leg('select.refusal_without_semantic_route', 'A combo with no semantic route is refused with no effect', 'Settings', ('x11-openbox', 'x11-mutter'), ('headless', 'headed'), ('gsettings',), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('placeholder.settings_apps_search', 'Applications search reports its placeholder and no description', 'Settings', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('placeholder.files_search_none', 'Files search has no placeholder and headed typing reaches its focused internal editor', 'Files', ('x11-openbox', 'x11-mutter'), ('headless', 'headed'), ('atspi', 'x11'), 'pass', ''),
    Leg('zero_bounds.files_container_raw_only', 'A zero-axis Files container gets no ref and is covered as raw geometry', 'Files', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('zero_bounds.settings_container_raw_only', 'A zero-axis Settings container gets no ref and is covered as raw geometry', 'Settings', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('zero_bounds.hidden_menu_items_not_visible', 'Hidden menu bar items read as not visible', 'Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('duplicates.two_processes_distinct_window_ids', 'Two Calculator processes have distinct window ids that each snapshot', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('duplicates.main_menu_nodes_separate', 'Main Menu resolves its menubutton and switch as separate nodes', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('toolkit_qt.refs_and_completeness', 'The first snapshot of the Qt window is complete with refs', 'Qt window', ('x11-openbox', 'x11-mutter'), ('headless',), ('applog',), 'pass', ''),
    Leg('toolkit_qt.headless_click_logged_once', 'A headless click logs exactly one activation', 'Qt window', ('x11-openbox',), ('headless',), ('applog',), 'pass', ''),
    Leg('toolkit_qt.scroll_refused_no_container', 'Scroll is refused with no_scroll_container', 'Qt window', ('x11-openbox',), ('headless',), ('applog',), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('toolkit_qt.wait_menu_opens', 'wait --menu succeeds after the menu opens', 'Qt window', ('x11-openbox',), ('headless',), ('applog',), 'pass', ''),
    Leg('toolkit_qt.wait_menu_closes', 'wait --menu-closed succeeds after the menu closes', 'Qt window', ('x11-openbox',), ('headless',), ('applog',), 'pass', ''),
    Leg('toolkit_qt.menu_already_open', 'A menu predicate reads the already-open state at once', 'Qt window', ('x11-openbox',), ('headless',), ('applog',), 'pass', ''),
    Leg('toolkit_qt.headed_click_logged_once', 'A headed click logs exactly one activation', 'Qt window', ('x11-openbox', 'x11-mutter'), ('headed',), ('applog',), 'pass', ''),
    Leg('headed_actions.focus_reads_active_window', "The product's focus step makes the target the active window", 'Calculator', ('x11-openbox', 'x11-mutter'), ('headed',), ('atspi', 'x11'), 'pass', ''),
    Leg('headed_actions.type_text', 'Headed typing reaches the document', 'Text Editor', ('x11-openbox', 'x11-mutter'), ('headed',), ('atspi', 'x11'), 'pass', ''),
    Leg('pointer.drag_delivery_report', 'The drag delivery report agrees with the oracle delivered and undelivered', 'Text Editor', ('x11-openbox',), ('headed',), ('x11', 'atspi'), 'pass', ''),
    Leg('pointer.mouse_wheel_delivery_report', 'The wheel delivery report agrees with the oracle delivered and undelivered', 'Text Editor', ('x11-openbox', 'x11-mutter'), ('headed',), ('x11', 'atspi'), 'pass', ''),
    Leg('pointer.mouse_click_delivery_report', 'The mouse-click delivery report agrees with the oracle delivered and undelivered', 'Calculator', ('x11-openbox',), ('headed',), ('x11', 'atspi'), 'pass', ''),
    Leg('occlusion.ordinary_cover_removed_click_lands', 'An ordinary cover is removed by focus preparation and the click lands', 'Calculator over Text Editor', ('x11-openbox', 'x11-mutter'), ('headed',), ('x11', 'atspi'), 'pass', ''),
    Leg('occlusion.above_cover_refused_no_effect', 'An above-layer cover is refused with no effect in either window', 'Calculator over Text Editor', ('x11-openbox',), ('headed',), ('x11', 'atspi'), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('occlusion.above_flag_dropped_click_lands', 'Without the above flag the same click lands in the editor', 'Calculator over Text Editor', ('x11-openbox',), ('headed',), ('x11', 'atspi'), 'pass', ''),
    Leg('text_entry.typed_text_reaches_document', 'Typed text reaches the document', 'Text Editor', ('x11-openbox',), ('headed',), ('atspi', 'x11'), 'pass', ''),
    Leg('text_entry.held_key_released', 'A held key is not left pressed', 'Text Editor', ('x11-openbox', 'x11-mutter'), ('headed',), ('atspi', 'x11'), 'pass', ''),
    Leg('text_entry.press_combos_edit_document', 'press return inserts one newline, ctrl+a then backspace empties the document, and no modifier stays down', 'Text Editor', ('x11-openbox', 'x11-mutter'), ('headed',), ('atspi', 'x11'), 'pass', ''),
    Leg('non_interference.active_window_unchanged_by_semantic_click', 'A semantic click leaves the active window and the pointer as they were', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('x11', 'atspi'), 'pass', ''),
    Leg('lifecycle.close_app_undelivered_report', 'close-app reports not delivered when the process stays', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('x11', 'proc'), 'pass', ''),
    Leg('lifecycle.focus_window_active_reads', 'focus-window makes the target active by the X11 reads', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('x11', 'proc'), 'pass', ''),
    Leg('lifecycle.minimize_restore', 'minimize and restore change the window state the oracle reads', 'Calculator', ('x11-openbox',), ('headless',), ('x11', 'proc'), 'pass', ''),
    Leg('lifecycle.maximize_restore', 'maximize and restore change the window state the oracle reads', 'Calculator', ('x11-openbox',), ('headless',), ('x11', 'proc'), 'pass', ''),
    Leg('lifecycle.window_operation_delivery_reports', 'move, resize and minimize reports agree with the oracle both ways', 'Calculator', ('x11-openbox',), ('headless',), ('x11', 'proc'), 'pass', ''),
    Leg('clipboard.text_roundtrip', 'Text round trips against a foreign producer and reader', 'foreign client', ('x11-openbox', 'x11-mutter'), ('headless',), ('clipboard',), 'pass', ''),
    Leg('clipboard.image_roundtrip', 'An image round trips against a foreign producer and reader', 'foreign client', ('x11-openbox', 'x11-mutter'), ('headless',), ('clipboard',), 'pass', ''),
    Leg('clipboard.owner_outlives_setter', 'The selection owner outlives the setter process', 'foreign client', ('x11-openbox', 'x11-mutter'), ('headless',), ('clipboard',), 'pass', ''),
    Leg('clipboard.clear_leaves_empty', 'clipboard-clear leaves the clipboard empty', 'foreign client', ('x11-openbox', 'x11-mutter'), ('headless',), ('clipboard',), 'pass', ''),
    Leg('events.window_opened_quiet', 'wait --event window-opened times out with no transition', 'Calculator, Text Editor, Files, Terminal', ('x11-openbox',), ('headless',), ('atspi', 'proc'), 'pass', ''),
    Leg('events.window_closed_transition', 'wait --event window-closed succeeds on a real transition', 'Calculator, Text Editor, Files, Terminal', ('x11-openbox',), ('headless',), ('atspi', 'proc'), 'pass', ''),
    Leg('events.window_closed_quiet', 'wait --event window-closed times out with no transition', 'Calculator, Text Editor, Files, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'proc'), 'pass', ''),
    Leg('events.app_launched_quiet', 'wait --event app-launched times out with no transition', 'Calculator, Text Editor, Files, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'proc'), 'pass', ''),
    Leg('events.app_terminated_transition', 'wait --event app-terminated succeeds on a real transition', 'Calculator, Text Editor, Files, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'proc'), 'pass', ''),
    Leg('events.scoped_and_unscoped_forms', 'Each event wait works scoped to a process and unscoped', 'Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'x11'), 'pass', ''),
    Leg('events.open_and_close_inside_one_wait', 'A window that opens and closes inside one wait is reported', 'Text Editor', ('x11-openbox',), ('headless',), ('atspi', 'x11'), 'pass', ''),
    Leg('events.target_killed_mid_wait', 'A target killed mid-wait is reported as such', 'Text Editor', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'x11', 'proc'), 'pass', ''),
    Leg('menus.wait_menu_opens_calculator', 'wait --menu succeeds on the Calculator main menu', 'Calculator, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('menus.wait_menu_closes_calculator', 'wait --menu-closed succeeds on the Calculator main menu', 'Calculator, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('menus.wait_menu_already_open', 'A menu predicate reads the already-open state at once', 'Calculator, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('menus.preferences_find_ref', 'A menu find ref opens a unique Preferences dialog observed through AT-SPI', 'Calculator', ('x11-mutter',), HEADLESS, ('atspi', 'x11'), 'pass'),
    Leg('menus.hidden_bar_timeout_message', 'A hidden menu bar times out with the landed message', 'Calculator, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('identity.restart_old_id_window_not_found', 'After a restart the old window id answers WINDOW_NOT_FOUND', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'proc'), 'pass', ''),
    Leg('identity.restart_new_id_resolves', 'After a restart the new window id resolves', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'proc'), 'pass', ''),
    Leg('identity.id_survives_unrelated_launch', 'A window id survives the launch of an unrelated app', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'proc'), 'pass', ''),
    Leg('surfaces.batch_seed_opener_about', 'A pre-action batch baseline observes About appearing without a title filter', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('surfaces.baseline_after_opener_fails', 'A baseline taken after About opens times out inside a successful batch envelope', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'pass', ''),
    Leg('launch.launch_calculator_attributed', 'launch starts Calculator and the registry diff attributes it', 'Calculator, Text Editor, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('proc', 'atspi'), 'pass', ''),
    Leg('launch.launch_text_editor_new_window', 'A second launch gives Text Editor a new window', 'Calculator, Text Editor, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('proc', 'atspi'), 'pass', ''),
    Leg('launch.launch_terminal_owner', "Terminal's owner is the terminal server, not the spawned pid", 'Calculator, Text Editor, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('proc', 'atspi'), 'pass', ''),
    Leg('launch.list_apps_alias', 'list-apps answers like its alias', 'Calculator, Text Editor, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('proc', 'atspi'), 'pass', ''),
    Leg('launch.launch_suggestion', 'A failed launch carries the landed suggestion', 'Calculator, Text Editor, Terminal', ('x11-openbox', 'x11-mutter'), ('headless',), ('proc', 'atspi'), 'pass', ''),
    Leg('launch.recovery_strategy_on_error', 'A dead-owner ref is nonretryable without a recovery token or relaunch', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('proc', 'atspi'), 'asserted-refusal', 'STALE_REF, exited, retryable=false, not_delivered/safe, no recovery token'),
    Leg('notifications.app_filter_case_insensitive', 'The app filter is a case-insensitive contains', 'GNOME shell', ('x11-mutter',), ('headless',), ('dbus',), 'pass', ''),
    Leg('notifications.wait_notification_passes', 'wait --notification passes near the send', 'GNOME shell', ('x11-mutter',), ('headless',), ('dbus',), 'pass', ''),
    Leg('notifications.wait_notification_times_out', 'wait --notification times out with none sent', 'GNOME shell', ('x11-mutter',), ('headless',), ('dbus',), 'asserted-refusal', 'TIMEOUT with unchanged notifications and no daemon mutation signal'),
    Leg('notifications.headless_mutations_policy_denied', 'Headless mutations answer POLICY_DENIED and the list is unchanged', 'GNOME shell', ('x11-mutter',), ('headless',), ('dbus',), 'asserted-refusal', 'POLICY_DENIED with unchanged notifications and no daemon mutation signal'),
    Leg('notifications.wrong_app_not_found', 'A wrong expected app answers NOTIFICATION_NOT_FOUND with no signal', 'GNOME shell', ('x11-mutter',), ('headed',), ('dbus',), 'asserted-refusal', 'NOTIFICATION_NOT_FOUND with unchanged notifications and no daemon mutation signal'),
    Leg('notifications.dismiss_notification_closes_only_target', 'dismiss-notification closes only the owned target with daemon reason 2 and preserves its bystander', 'GNOME shell', ('x11-mutter',), ('headed',), ('dbus',), 'pass', ''),
    Leg('notifications.dismiss_all_closes_every_notification', 'dismiss-all closes every notification', 'GNOME shell', ('x11-mutter',), ('headed',), ('dbus',), 'pass', ''),
    Leg('tray.headless_activate_logged', "Headless click delivers Activate as the sender's log shows", 'harness tray item', ('x11-mutter',), ('headless',), ('applog', 'dbus'), 'pass', ''),
    Leg('tray.headless_menu_event_clicked', 'Headless menu click delivers Event(id, clicked) as the log shows', 'harness tray item', ('x11-mutter',), ('headless',), ('applog', 'dbus'), 'pass', ''),
    Leg('tray.item_without_activate_refused', 'An item without Activate is refused with no call logged', 'harness tray item', ('x11-mutter',), ('headless',), ('applog', 'dbus'), 'asserted-refusal', 'POLICY_DENIED because no semantic Activate is advertised; no Activate'),
    Leg('tray.killed_owner_stale_ref', 'A killed owner turns the old ref into STALE_REF', 'harness tray item', ('x11-mutter',), ('headless',), ('applog', 'dbus'), 'asserted-refusal', 'STALE_REF after the independently observed owner exit; no Activate'),
    Leg('wayland_actions.focus_window_wayland_session_refusal', 'focus-window refuses wayland_session before anything is sent', 'Calculator', ('wayland',), ('headless',), ('atspi', 'x11'), 'asserted-refusal', "the leg asserts the product's refusal as its expected outcome"),
    Leg('wayland_actions.list_windows_no_position', 'list-windows reports no position', 'Calculator', ('wayland',), ('headless',), ('atspi', 'x11'), 'pass', ''),
    Leg('wayland_actions.unhealthy_shell_named_reason', 'A shell that never becomes healthy fails the tier with its named reason', 'Calculator', ('wayland',), ('headless',), ('proc',), 'pass', ''),
    Leg('gaps.delayed_enable', 'controlled enable dispatches exactly once', 'Qt delayed button', ('x11-openbox', 'x11-mutter'), ('headless', 'headed'), ('atspi', 'applog', 'x11'), 'pass', ''),
    Leg('gaps.timeout_default', 'default disabled-action timeout without an effect', 'Calculator Undo', ('x11-openbox', 'x11-mutter'), ('headless', 'headed'), ('atspi',), 'asserted-refusal', 'Disabled Undo: TIMEOUT, details.kind=actionability_timeout, unchanged state/text, default 5000 ms budget.'),
    Leg('wayland_actions.semantic_click_without_seat', 'A semantic click succeeds without a keyboard seat and restores the display', 'Calculator', ('wayland',), ('headless',), ('atspi',), 'pass', ''),
    Leg('wayland_actions.headed_ref_refusal', 'Headed ref action refuses Wayland focus before dispatch', 'Calculator', ('wayland',), ('headed',), ('atspi',), 'asserted-refusal', 'ACTION_NOT_SUPPORTED, cause=wayland_session, not_delivered with unchanged raw display'),
    Leg('error_contract.recoverable_error_envelopes', 'A bare @e1 is INVALID_ARGS with the qualified-ref suggestion, an unknown snapshot is SNAPSHOT_NOT_FOUND with a refresh-snapshot recovery, an unknown app is APP_NOT_FOUND with a list-apps suggestion, each not_delivered and exit 1 with the app untouched', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi', 'proc'), 'asserted-refusal', 'INVALID_ARGS, SNAPSHOT_NOT_FOUND and APP_NOT_FOUND envelopes carry suggestion and disposition with exit 1; display and owned processes unchanged'),
    Leg('batch_contract.entry_failure_and_stop_on_error', 'A failed batch entry reports its own STALE_REF and later entries still run; --stop-on-error halts with stopped.reason and the failing index; the display shows exactly the entries that ran', 'Calculator', ('x11-openbox', 'x11-mutter'), ('headless',), ('atspi',), 'asserted-refusal', 'the failing entry answers STALE_REF inside an ok batch envelope; stopped.reason stop_on_error at index 1; display 78 without the flag and 7 with it'),
)

RESTORED_MUTTER_EVENTS = (
    'gaps.event_window-opened_scoped_success.mutter_owner',
    'gaps.event_window-opened_scoped_quiet.mutter_owner',
    'gaps.event_window-opened_unscoped_success.mutter_owner',
    'gaps.event_window-closed_scoped_quiet.mutter_owner',
    'gaps.event_window-closed_unscoped_quiet.mutter_owner',
    'gaps.event_app-launched_scoped_success.mutter_owner',
    'gaps.event_app-launched_scoped_quiet.mutter_owner',
    'gaps.event_app-launched_unscoped_success.mutter_owner',
    'gaps.event_app-launched_unscoped_quiet.mutter_owner',
)
REGISTRY += tuple(Leg(name, "seeded event with independent owner/frame restoration",
                      "Calculator and Text Editor", ("x11-mutter",), ("headless",),
                      ("atspi", "x11", "proc"), "pass") for name in RESTORED_MUTTER_EVENTS)

REGISTRY += tuple(
    Leg(f"ref_contract.zoo_{toolkit}{suffix}",
        (f"Every snapshot ref of the {label} zoo lands or is marked and refused"
         if not suffix else f"The {label} zoo exposes and operates its window surfaces"),
        f"Zoo {label}", ALL_TIERS, HEADLESS, ("atspi", "applog"), "pass")
    for toolkit, label in (("gtk3", "GTK3"), ("gtk4", "GTK4"), ("qt", "Qt"))
    for suffix in ("", "_windows")
)

_BY_ID = {leg.id: leg for leg in REGISTRY}
if len(_BY_ID) != len(REGISTRY):
    raise ValueError("duplicate leg id in the registry")

_IMPLEMENTATIONS: dict[str, Callable] = {}


def leg_by_id(leg_id: str) -> Leg:
    return _BY_ID[leg_id]


def implementation(leg_id: str):
    if leg_id not in _BY_ID:
        raise KeyError(f"implementation for unregistered leg {leg_id}")

    def register(fn):
        if leg_id in _IMPLEMENTATIONS:
            raise ValueError(f"leg {leg_id} has two implementations")
        _IMPLEMENTATIONS[leg_id] = fn
        return fn

    return register


def implementations() -> dict[str, Callable]:
    return dict(_IMPLEMENTATIONS)


# Keep scenario loading lazy: this module is imported by scenarios themselves.
def _ref_contract(ctx):
    from scenarios.ref_contract import refs
    from scenarios.ref_contract_windows import windows
    (windows if ctx.leg.id.endswith("_windows") else refs)(ctx)


for _leg in REGISTRY:
    if _leg.id.startswith("ref_contract."):
        implementation(_leg.id)(_ref_contract)
