#ifndef AGENT_DESKTOP_H
#define AGENT_DESKTOP_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
/*
 * Agent workflow — quick orientation for C/C++ binding authors:
 *
 *  1. (Optional) Call ad_init(AD_ABI_VERSION_MAJOR) to verify at runtime that
 *     the header you compiled against matches the loaded dylib.  A version
 *     mismatch returns ErrInvalidArgs; abort rather than proceed.
 *
 *  2. Create an adapter:
 *       AdAdapter *a = ad_adapter_create();            // no session
 *       AdAdapter *a = ad_adapter_create_with_session(session_id); // with session
 *
 *  3. Observe via ad_snapshot().  The returned JSON envelope contains the
 *     accessibility tree with snapshot-qualified ref IDs (for example,
 *     "@s8f3k2p9:e5") that address
 *     individual interactive elements.  A refmap is written under the state
 *     root (default ~/.agent-desktop, or AGENT_DESKTOP_HOME) and is keyed to
 *     the snapshot ID.  The envelope carries
 *     data.snapshot_id. Qualified refs already pin the exact snapshot.
 *
 *  4. Act via ad_execute_by_ref(a, "@s8f3k2p9:e5", &action, policy, &out).
 *     Build an AdAction by zero-initialising it and setting its kind field to
 *     an AD_ACTION_KIND_* constant plus any kind-specific fields (e.g. .text
 *     for AD_ACTION_KIND_TYPE_TEXT).  policy=0 (Headless) keeps each action's
 *     built-in base behaviour; pass 2 (Headed) to additionally allow
 *     cursor/focus fallbacks.  ref_id must be non-null (null returns
 *     ErrInvalidArgs immediately).
 *
 *  5. Ownership: every non-null *out string must be freed with ad_free_string().
 *     Destroy the adapter when done with ad_adapter_destroy(a).
 *
 * Calls may originate on any host thread. Native element handles remain
 * thread-affine and must be used and released on the thread that resolved
 * them. Desktop mutations are serialized by an interaction lease.
 */


/**
 * The major ABI version of this build of `libagent_desktop_ffi`.
 *
 * Version-bump rule: increment this constant (and update the header via
 * `scripts/update-ffi-header.sh`) whenever a breaking change is made to the
 * C ABI — a removed or incompatibly-changed `ad_*` symbol, or a layout
 * change to any `repr(C)` struct. Additive changes (new `ad_*` symbols, new
 * error codes) do **not** require a bump. It is recommended to call `ad_init`
 * with the major compiled against the header to verify ABI compatibility; a
 * mismatch means the header and dylib are incompatible and the consumer should
 * refuse to proceed rather than risk undefined behaviour.
 */
#define AD_ABI_VERSION_MAJOR 6

/**
 * Maximum byte length (excluding the NUL terminator) accepted for any
 * foreign C string. Bounds both the terminator scan and the resulting
 * allocation, so a missing NUL or a hostile caller cannot walk arbitrary
 * memory into a `String`. Sized to roughly match the CLI's argv ceiling so
 * payload-bearing calls (clipboard-set, type) keep CLI parity rather than
 * being cut off at a ref-field-sized cap. Mirrored in the header as
 * `AD_MAX_STRING_BYTES`.
 */
#define AD_MAX_STRING_BYTES (1024 * 1024)

#define AD_ACTION_SIZE 96

#define AD_ACTION_RESULT_SIZE 56

#define AD_ACTION_STEP_SIZE 32

#define AD_DELIVERY_SEMANTICS_SIZE 8

#define AD_DISPLAY_INFO_VERSION 1

#define AD_DISPLAY_INFO_SIZE 64

#define AD_DRAG_PARAMS_SIZE 48

#define AD_ELEMENT_STATE_SIZE 32

#define AD_EXACT_REF_ENTRY_VERSION 2

#define AD_EXACT_REF_ENTRY_SIZE 224

#define AD_EXACT_SURFACE_INFO_VERSION 2

#define AD_EXACT_SURFACE_INFO_SIZE 48

#define AD_EXACT_WINDOW_INFO_VERSION 2

#define AD_EXACT_WINDOW_INFO_SIZE 96

#define AD_FIND_CONTROL_SIZE 24

#define AD_FIND_FILTER_SIZE 88

#define AD_FIND_IDENTITY_SIZE 40

#define AD_FIND_QUERY_VERSION 1

#define AD_FIND_QUERY_SIZE 112

#define AD_FIND_SELECTION_SIZE 8

#define AD_FIND_STATE_PREDICATE_SIZE 16

#define AD_FIND_STATE_SLICE_SIZE 16

#define AD_MODIFIER_CMD 0

#define AD_NODE_SIZE 112

#define AD_NODE_CONTENT_SIZE 48

#define AD_NODE_PRESENTATION_SIZE 48

#define AD_NODE_RELATION_SIZE 12

#define AD_NOTIFICATION_ACTION_REQUEST_SIZE 32

#define AD_NOTIFICATION_IDENTITY_SIZE 16

#define AD_OPTIONAL_U64_SIZE 16

#define AD_OPTIONAL_USIZE_SIZE 16

#define AD_REF_CAPABILITIES_SIZE 32

#define AD_REF_ENTRY_SIZE 200

/**
 * Per-field input caps enforced when converting an `AdRefEntry` at the C
 * boundary, sized from what real accessibility trees produce (a handful of
 * states/actions, double-digit path depth) with generous headroom. Mirrored
 * in the header so callers can validate before calling.
 */
#define AD_MAX_REF_STATES 64

#define AD_MAX_REF_ACTIONS 32

#define AD_MAX_REF_PATH_DEPTH 128

#define AD_BOUNDS_SPACE_UNKNOWN 0

#define AD_BOUNDS_SPACE_SCREEN 1

#define AD_BOUNDS_SPACE_WINDOW 2

#define AD_REF_GEOMETRY_SIZE 48

#define AD_REF_IDENTITY_SIZE 40

#define AD_REF_PROCESS_SIZE 4

#define AD_REF_SCOPE_SIZE 32

#define AD_REF_SOURCE_SIZE 40

#define AD_STRING_SLICE_SIZE 16

/**
 * Pinned size of `AdWaitArgs` on 64-bit targets. The compile-time
 * assert below and the `ad_wait_args_size()` runtime getter form the
 * 3-layer pin: Rust const assert, C `_Static_assert` in the header,
 * and the test in `c_abi_layout.rs`.
 */
#define AD_WAIT_ARGS_SIZE 104

#define AD_WAIT_MODE_SIZE 48

#define AD_WAIT_PREDICATE_SIZE 40

#define AD_WAIT_SCOPE_SIZE 16

#define AD_WAIT_SURFACE_MODES_SIZE 3

/**
 * New result codes may be appended in future releases. Always handle values
 * outside this list.
 */
enum AdResult
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_RESULT_OK = 0,
  AD_RESULT_ERR_PERM_DENIED = -1,
  AD_RESULT_ERR_ELEMENT_NOT_FOUND = -2,
  AD_RESULT_ERR_APP_NOT_FOUND = -3,
  AD_RESULT_ERR_ACTION_FAILED = -4,
  AD_RESULT_ERR_ACTION_NOT_SUPPORTED = -5,
  AD_RESULT_ERR_STALE_REF = -6,
  AD_RESULT_ERR_WINDOW_NOT_FOUND = -7,
  AD_RESULT_ERR_PLATFORM_NOT_SUPPORTED = -8,
  AD_RESULT_ERR_TIMEOUT = -9,
  AD_RESULT_ERR_INVALID_ARGS = -10,
  AD_RESULT_ERR_NOTIFICATION_NOT_FOUND = -11,
  AD_RESULT_ERR_INTERNAL = -12,
  AD_RESULT_ERR_SNAPSHOT_NOT_FOUND = -13,
  AD_RESULT_ERR_POLICY_DENIED = -14,
  AD_RESULT_ERR_AMBIGUOUS_TARGET = -15,
  AD_RESULT_ERR_APP_UNRESPONSIVE = -16,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdResult AdResult;
#else
typedef int32_t AdResult;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdImageFormat
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_IMAGE_FORMAT_PNG = 0,
  AD_IMAGE_FORMAT_JPG = 1,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdImageFormat AdImageFormat;
#else
typedef int32_t AdImageFormat;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdActionKind
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_ACTION_KIND_CLICK = 0,
  AD_ACTION_KIND_DOUBLE_CLICK = 1,
  AD_ACTION_KIND_RIGHT_CLICK = 2,
  AD_ACTION_KIND_TRIPLE_CLICK = 3,
  AD_ACTION_KIND_SET_VALUE = 4,
  AD_ACTION_KIND_SET_FOCUS = 5,
  AD_ACTION_KIND_EXPAND = 6,
  AD_ACTION_KIND_COLLAPSE = 7,
  AD_ACTION_KIND_SELECT = 8,
  AD_ACTION_KIND_TOGGLE = 9,
  AD_ACTION_KIND_CHECK = 10,
  AD_ACTION_KIND_UNCHECK = 11,
  AD_ACTION_KIND_SCROLL = 12,
  AD_ACTION_KIND_SCROLL_TO = 13,
  AD_ACTION_KIND_PRESS_KEY = 14,
  AD_ACTION_KIND_KEY_DOWN = 15,
  AD_ACTION_KIND_KEY_UP = 16,
  AD_ACTION_KIND_TYPE_TEXT = 17,
  AD_ACTION_KIND_CLEAR = 18,
  AD_ACTION_KIND_HOVER = 19,
  AD_ACTION_KIND_DRAG = 20,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdActionKind AdActionKind;
#else
typedef int32_t AdActionKind;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdDirection
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_DIRECTION_UP = 0,
  AD_DIRECTION_DOWN = 1,
  AD_DIRECTION_LEFT = 2,
  AD_DIRECTION_RIGHT = 3,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdDirection AdDirection;
#else
typedef int32_t AdDirection;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdDeliveryDisposition
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_DELIVERY_DISPOSITION_UNKNOWN = 0,
  AD_DELIVERY_DISPOSITION_NOT_DELIVERED = 1,
  AD_DELIVERY_DISPOSITION_DELIVERY_UNCERTAIN = 2,
  AD_DELIVERY_DISPOSITION_DELIVERED_UNVERIFIED = 3,
  AD_DELIVERY_DISPOSITION_DELIVERED_VERIFIED = 4,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdDeliveryDisposition AdDeliveryDisposition;
#else
typedef int32_t AdDeliveryDisposition;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdFindSelectionKind
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_FIND_SELECTION_KIND_STRICT = 0,
  AD_FIND_SELECTION_KIND_FIRST = 1,
  AD_FIND_SELECTION_KIND_LAST = 2,
  AD_FIND_SELECTION_KIND_NTH = 3,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdFindSelectionKind AdFindSelectionKind;
#else
typedef int32_t AdFindSelectionKind;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdIdentifierKind
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_IDENTIFIER_KIND_AX_IDENTIFIER = 0,
  AD_IDENTIFIER_KIND_AX_DOM_IDENTIFIER = 1,
  AD_IDENTIFIER_KIND_AUTOMATION_ID = 2,
  AD_IDENTIFIER_KIND_RUNTIME_ID = 3,
  AD_IDENTIFIER_KIND_ATSPI_OBJECT_PATH = 4,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdIdentifierKind AdIdentifierKind;
#else
typedef int32_t AdIdentifierKind;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdModifier
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_MODIFIER_META = 0,
  AD_MODIFIER_CTRL = 1,
  AD_MODIFIER_ALT = 2,
  AD_MODIFIER_SHIFT = 3,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdModifier AdModifier;
#else
typedef int32_t AdModifier;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdMouseButton
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_MOUSE_BUTTON_LEFT = 0,
  AD_MOUSE_BUTTON_RIGHT = 1,
  AD_MOUSE_BUTTON_MIDDLE = 2,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdMouseButton AdMouseButton;
#else
typedef int32_t AdMouseButton;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdMouseEventKind
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_MOUSE_EVENT_KIND_MOVE = 0,
  AD_MOUSE_EVENT_KIND_DOWN = 1,
  AD_MOUSE_EVENT_KIND_UP = 2,
  AD_MOUSE_EVENT_KIND_CLICK = 3,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdMouseEventKind AdMouseEventKind;
#else
typedef int32_t AdMouseEventKind;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdPolicyKind
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_POLICY_KIND_HEADLESS = 0,
  AD_POLICY_KIND_FOCUS_FALLBACK = 1,
  AD_POLICY_KIND_HEADED = 2,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdPolicyKind AdPolicyKind;
#else
typedef int32_t AdPolicyKind;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdRetryDisposition
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_RETRY_DISPOSITION_UNKNOWN = 0,
  AD_RETRY_DISPOSITION_SAFE = 1,
  AD_RETRY_DISPOSITION_UNSAFE = 2,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdRetryDisposition AdRetryDisposition;
#else
typedef int32_t AdRetryDisposition;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdScreenshotKind
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_SCREENSHOT_KIND_SCREEN = 0,
  AD_SCREENSHOT_KIND_FULL_SCREEN = 2,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdScreenshotKind AdScreenshotKind;
#else
typedef int32_t AdScreenshotKind;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdSnapshotSurface
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_SNAPSHOT_SURFACE_WINDOW = 0,
  AD_SNAPSHOT_SURFACE_FOCUSED = 1,
  AD_SNAPSHOT_SURFACE_MENU = 2,
  AD_SNAPSHOT_SURFACE_MENUBAR = 3,
  AD_SNAPSHOT_SURFACE_SHEET = 4,
  AD_SNAPSHOT_SURFACE_POPOVER = 5,
  AD_SNAPSHOT_SURFACE_ALERT = 6,
  AD_SNAPSHOT_SURFACE_DESKTOP = 7,
  AD_SNAPSHOT_SURFACE_TASKBAR = 8,
  AD_SNAPSHOT_SURFACE_SYSTEM_TRAY = 9,
  AD_SNAPSHOT_SURFACE_QUICK_SETTINGS = 10,
  AD_SNAPSHOT_SURFACE_NOTIFICATION_CENTER = 11,
  AD_SNAPSHOT_SURFACE_TOOLBAR = 12,
  AD_SNAPSHOT_SURFACE_DOCK = 13,
  AD_SNAPSHOT_SURFACE_SPOTLIGHT = 14,
  AD_SNAPSHOT_SURFACE_MENU_BAR_EXTRAS = 15,
  AD_SNAPSHOT_SURFACE_SYSTEM_TRAY_OVERFLOW = 16,
  AD_SNAPSHOT_SURFACE_START_MENU = 17,
  AD_SNAPSHOT_SURFACE_ACTION_CENTER = 18,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdSnapshotSurface AdSnapshotSurface;
#else
typedef int32_t AdSnapshotSurface;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdStepMechanism
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_STEP_MECHANISM_SEMANTIC_API = 1,
  AD_STEP_MECHANISM_PHYSICAL_SYNTHETIC = 2,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdStepMechanism AdStepMechanism;
#else
typedef int32_t AdStepMechanism;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

enum AdWindowOpKind
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int32_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  AD_WINDOW_OP_KIND_RESIZE = 0,
  AD_WINDOW_OP_KIND_MOVE = 1,
  AD_WINDOW_OP_KIND_MINIMIZE = 2,
  AD_WINDOW_OP_KIND_MAXIMIZE = 3,
  AD_WINDOW_OP_KIND_RESTORE = 4,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum AdWindowOpKind AdWindowOpKind;
#else
typedef int32_t AdWindowOpKind;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

typedef struct AdAdapter AdAdapter;

/**
 * Opaque list handle emitted by `ad_list_apps`.
 */
typedef struct AdAppList AdAppList;

/**
 * Opaque list handle emitted by `ad_list_displays`.
 */
typedef struct AdDisplayList AdDisplayList;

/**
 * Opaque list handle emitted by `ad_list_surfaces_exact`.
 */
typedef struct AdExactSurfaceList AdExactSurfaceList;

/**
 * Opaque list handle emitted by ad_list_windows_exact.
 */
typedef struct AdExactWindowList AdExactWindowList;

/**
 * Opaque image-buffer handle returned by `ad_screenshot`. The backing
 * byte buffer and its length live inside the Rust-owned struct — a
 * consumer cannot accidentally desynchronize the pair and trigger a
 * heap-corruption double-free. Walk it through `ad_image_buffer_*`
 * accessors and free it with `ad_image_buffer_free`.
 */
typedef struct AdImageBuffer AdImageBuffer;

/**
 * Opaque notification list returned by `ad_list_notifications`.
 */
typedef struct AdNotificationList AdNotificationList;

typedef struct AdNativeHandle {
  /**
   * Opaque thread-affine registry token, never an allocation or OS pointer.
   */
  const void *ptr;
} AdNativeHandle;

/**
 * Scroll parameters embedded in `AdAction` when `kind == SCROLL`.
 *
 * `direction` is stored as `int32_t` for the same boundary-safety
 * reason `AdAction.kind` is. Valid values are the discriminants of
 * `AdDirection`.
 */
typedef struct AdScrollParams {
  int32_t direction;
  uint32_t amount;
} AdScrollParams;

/**
 * Key combination: a named key plus optional modifier list.
 *
 * `modifiers` points to an array of `int32_t` values (not a typed Rust
 * enum array) so the C boundary cannot be tricked into writing an
 * out-of-range discriminant into a Rust enum slot. Each entry is
 * validated against `AdModifier` before use; an invalid discriminant
 * returns `AD_RESULT_ERR_INVALID_ARGS`.
 */
typedef struct AdKeyCombo {
  const char *key;
  const int32_t *modifiers;
  uint32_t modifier_count;
} AdKeyCombo;

typedef struct AdPoint {
  double x;
  double y;
} AdPoint;

/**
 * Caller-allocated drag parameters. Callers must zero-initialize the whole
 * struct before setting fields so unset numeric fields read as the `0`
 * adapter-default sentinel rather than stack garbage. Verify layout against
 * `AD_DRAG_PARAMS_SIZE` / `ad_drag_params_size()` when binding from a language
 * whose struct layout may diverge.
 */
typedef struct AdDragParams {
  struct AdPoint from;
  struct AdPoint to;
  uint64_t duration_ms;
  uint64_t drop_delay_ms;
} AdDragParams;

/**
 * Action dispatched by `ad_execute_action`.
 *
 * `kind` is stored as `int32_t` so a buggy or malicious C caller
 * cannot write an out-of-range discriminant into a Rust enum slot —
 * an out-of-range value is rejected with
 * `AD_RESULT_ERR_INVALID_ARGS` at the boundary. Valid values are the
 * discriminants of `AdActionKind`.
 *
 * `AdDragParams` is embedded by value, so any growth there grows this
 * struct too. Callers must zero-initialize the whole struct and verify
 * layout against `AD_ACTION_SIZE` / `ad_action_size()` when binding from
 * a language whose struct layout may diverge — an under-allocated action
 * makes the library read past the caller's buffer.
 */
typedef struct AdAction {
  int32_t kind;
  const char *text;
  struct AdScrollParams scroll;
  struct AdKeyCombo key;
  struct AdDragParams drag;
} AdAction;

typedef struct AdElementState {
  const char *role;
  char **states;
  uint32_t state_count;
  const char *value;
} AdElementState;

typedef struct AdActionStep {
  const char *label;
  const char *outcome;
  int32_t mechanism;
  bool has_mechanism;
  bool verified;
  bool has_verified;
  uint64_t _reserved;
} AdActionStep;

typedef struct AdDeliverySemantics {
  int32_t delivery;
  int32_t retry;
} AdDeliverySemantics;

typedef struct AdActionResult {
  const char *action;
  const char *ref_id;
  struct AdElementState *post_state;
  struct AdActionStep *steps;
  uint32_t step_count;
  const char *details_json;
  struct AdDeliverySemantics disposition;
} AdActionResult;

typedef struct AdRefProcess {
  uint32_t pid;
} AdRefProcess;

typedef struct AdRefIdentity {
  const char *role;
  const char *name;
  const char *value;
  const char *description;
  const char *native_id;
} AdRefIdentity;

typedef struct AdRect {
  double x;
  double y;
  double width;
  double height;
} AdRect;

typedef struct AdRefGeometry {
  struct AdRect bounds;
  uint64_t bounds_hash;
  bool has_bounds;
  bool has_bounds_hash;
  /**
   * Coordinate frame of `bounds`; use an `AD_BOUNDS_SPACE_*` constant.
   * macOS and Windows geometry must be screen-relative. Linux geometry
   * must be window-relative.
   */
  int32_t bounds_space;
} AdRefGeometry;

typedef struct AdStringSlice {
  const char *const *items;
  size_t count;
} AdStringSlice;

typedef struct AdRefCapabilities {
  struct AdStringSlice states;
  struct AdStringSlice available_actions;
} AdRefCapabilities;

typedef struct AdRefSource {
  const char *app;
  const char *window_id;
  const char *window_title;
  uint64_t window_bounds_hash;
  int32_t surface;
  bool has_window_bounds_hash;
} AdRefSource;

typedef struct AdRefScope {
  const char *root_ref;
  const uint32_t *path;
  size_t path_count;
  bool path_is_absolute;
} AdRefScope;

typedef struct AdRefEntry {
  struct AdRefProcess process;
  struct AdRefIdentity identity;
  struct AdRefGeometry geometry;
  struct AdRefCapabilities capabilities;
  struct AdRefSource source;
  struct AdRefScope scope;
} AdRefEntry;

/**
 * Additive exact-identity payload for low-level struct-based ref actions.
 *
 * Callers must set `version` to `AD_EXACT_REF_ENTRY_VERSION`, `size` to
 * `AD_EXACT_REF_ENTRY_SIZE`, and `process_instance` to the generation token
 * emitted by the snapshot. When `entry.identity.native_id` is non-null,
 * `identifier_kind` must name its exact platform identifier namespace.
 */
typedef struct AdExactRefEntry {
  uint32_t version;
  uint32_t size;
  struct AdRefEntry entry;
  const char *process_instance;
  int32_t identifier_kind;
} AdExactRefEntry;

/**
 * Window fields embedded in `AdExactWindowInfo`, which adds the process
 * generation token every targeting API requires.
 */
typedef struct AdWindowInfo {
  const char *id;
  const char *title;
  const char *app_name;
  uint32_t pid;
  struct AdRect bounds;
  bool has_bounds;
  bool is_focused;
} AdWindowInfo;

/**
 * Additive generation-pinned window identity for operations that target a
 * previously observed live window.
 */
typedef struct AdExactWindowInfo {
  uint32_t version;
  uint32_t size;
  struct AdWindowInfo window;
  const char *process_instance;
  /**
   * False only when observation confirmed no matching accessibility element.
   */
  bool accessible;
} AdExactWindowInfo;

typedef struct AdAppInfo {
  const char *name;
  uint32_t pid;
  const char *bundle_id;
} AdAppInfo;

typedef struct AdOptionalU64 {
  uint64_t value;
  bool present;
} AdOptionalU64;

typedef struct AdWaitSurfaceModes {
  bool menu;
  bool menu_closed;
  bool notification;
} AdWaitSurfaceModes;

typedef struct AdWaitMode {
  struct AdOptionalU64 pause;
  const char *element;
  const char *window;
  const char *text;
  struct AdWaitSurfaceModes surfaces;
} AdWaitMode;

typedef struct AdOptionalUsize {
  size_t value;
  bool present;
} AdOptionalUsize;

typedef struct AdWaitPredicate {
  const char *predicate;
  const char *value;
  const char *action;
  struct AdOptionalUsize count;
} AdWaitPredicate;

typedef struct AdWaitScope {
  uint64_t timeout_ms;
  const char *app;
} AdWaitScope;

/**
 * Arguments for `ad_wait`, mirroring `core::commands::wait::WaitArgs` for
 * the pause/element/text/surface wait modes and predicates.
 *
 * The core event-wait mode (`--event` / `--window-id`) is intentionally not
 * exposed over FFI in this release; `wait_args_from_ffi` always forwards
 * `event: None` and `window_id: None` to core. `mode.window` here is a
 * title-appearance wait (poll until a window with the given title exists),
 * which is a distinct semantic from the deferred event-wait mode.
 *
 * Mode, predicate, and scope fields are grouped into named PODs. Optional
 * numbers use `AdOptional*`; optional strings are nullable pointers.
 *
 * Callers must zero-initialize before use and verify layout via
 * `AD_WAIT_ARGS_SIZE` / `ad_wait_args_size()`.
 */
typedef struct AdWaitArgs {
  struct AdWaitMode mode;
  struct AdWaitPredicate predicate;
  struct AdWaitScope scope;
} AdWaitArgs;

typedef struct AdDisplayInfo {
  uint32_t version;
  uint32_t size;
  const char *id;
  struct AdRect bounds;
  bool is_primary;
  double scale;
} AdDisplayInfo;

/**
 * Mouse event dispatched by `ad_mouse_event`.
 *
 * `kind` and `button` are stored as `int32_t` for the same reason
 * `AdAction.kind` is — foreign callers cannot place invalid
 * discriminants into Rust enum slots. Valid values are the
 * discriminants of `AdMouseEventKind` and `AdMouseButton`.
 */
typedef struct AdMouseEvent {
  int32_t kind;
  struct AdPoint point;
  int32_t button;
  uint32_t click_count;
} AdMouseEvent;

typedef struct AdNotificationIdentity {
  const char *app;
  const char *title;
} AdNotificationIdentity;

typedef struct AdNotificationActionRequest {
  uint32_t index;
  int32_t policy;
  const char *action_name;
  struct AdNotificationIdentity identity;
} AdNotificationActionRequest;

typedef struct AdNotificationFilter {
  const char *app;
  const char *text;
  uint32_t limit;
  bool has_limit;
} AdNotificationFilter;

typedef struct AdNotificationInfo {
  uint32_t index;
  const char *app_name;
  const char *title;
  const char *body;
  char **actions;
  uint32_t action_count;
} AdNotificationInfo;

typedef struct AdFindSelection {
  int32_t kind;
  uint32_t nth;
} AdFindSelection;

typedef struct AdFindControl {
  uint32_t version;
  struct AdFindSelection selection;
  uint64_t timeout_ms;
} AdFindControl;

typedef struct AdFindIdentity {
  const char *role;
  const char *name;
  const char *description;
  const char *native_id;
  const char *value;
} AdFindIdentity;

typedef struct AdFindStatePredicate {
  const char *token;
  int32_t expected;
} AdFindStatePredicate;

typedef struct AdFindStateSlice {
  const struct AdFindStatePredicate *items;
  size_t count;
} AdFindStateSlice;

typedef struct AdFindFilter {
  struct AdFindIdentity identity;
  const char *has_text;
  struct AdFindStateSlice states;
  const struct AdFindQuery *has;
  const struct AdFindQuery *has_not;
  bool exact;
} AdFindFilter;

typedef struct AdFindQuery {
  struct AdFindControl control;
  struct AdFindFilter filter;
} AdFindQuery;

/**
 * Screenshot target for `ad_screenshot`.
 *
 * `kind` is stored as `int32_t` to keep the enum-discriminant check
 * at the boundary. Valid values are the discriminants of
 * `AdScreenshotKind`. `screen_index` is only consulted when kind is
 * `SCREEN`. Window capture goes through `ad_screenshot_window_exact`.
 */
typedef struct AdScreenshotTarget {
  int32_t kind;
  uint64_t screen_index;
} AdScreenshotTarget;

/**
 * Surface fields embedded in `AdExactSurfaceInfo`, which adds the surface ID.
 */
typedef struct AdSurfaceInfo {
  const char *kind;
  const char *title;
  int64_t item_count;
} AdSurfaceInfo;

/**
 * Additive surface observation that preserves the core surface ID.
 */
typedef struct AdExactSurfaceInfo {
  uint32_t version;
  uint32_t size;
  const char *id;
  struct AdSurfaceInfo surface;
  /**
   * Comma-separated surface kinds that could not be read for this window
   * (for example `sheet,menu`), or null when every kind was read. A
   * missing `sheet` or `menu` entry next to a listed kind is unknown, not
   * absent. Present from version 2.
   */
  const char *unclassified;
} AdExactSurfaceInfo;

typedef struct AdNodeContent {
  const char *ref_id;
  const char *role;
  const char *name;
  const char *value;
  const char *description;
  const char *hint;
} AdNodeContent;

typedef struct AdNodePresentation {
  char **states;
  struct AdRect bounds;
  uint32_t state_count;
  bool has_bounds;
} AdNodePresentation;

typedef struct AdNodeRelation {
  int32_t parent_index;
  uint32_t child_start;
  uint32_t child_count;
} AdNodeRelation;

typedef struct AdNode {
  struct AdNodeContent content;
  struct AdNodePresentation presentation;
  struct AdNodeRelation relation;
} AdNode;

typedef struct AdNodeTree {
  struct AdNode *nodes;
  uint32_t count;
} AdNodeTree;

/**
 * Options for `ad_get_tree_exact`.
 *
 * `surface` is stored as `int32_t` so foreign callers cannot write
 * an invalid discriminant into a Rust enum slot. Valid values are the
 * discriminants of `AdSnapshotSurface`; out-of-range values return
 * `AD_RESULT_ERR_INVALID_ARGS`.
 */
typedef struct AdTreeOptions {
  uint8_t max_depth;
  bool include_bounds;
  bool interactive_only;
  bool compact;
  int32_t surface;
} AdTreeOptions;

/**
 * Window-manager operation dispatched by `ad_window_op_exact`.
 *
 * `kind` is stored as `int32_t` to keep the enum-discriminant check at
 * the boundary — out-of-range values return
 * `AD_RESULT_ERR_INVALID_ARGS`. Valid values are the discriminants of
 * `AdWindowOpKind`. `width`/`height`/`x`/`y` are only consulted for
 * the variants that use them.
 */
typedef struct AdWindowOp {
  int32_t kind;
  double width;
  double height;
  double x;
  double y;
} AdWindowOp;

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

/**
 * Returns the packed ABI major version of this dylib build.
 *
 * A consumer should compare this to `AD_ABI_VERSION_MAJOR` from the header it
 * compiled against. If they differ, call nothing further — the ABI is
 * incompatible.
 */
uint32_t ad_abi_version(void);

/**
 * Checks that the consumer's expected ABI major matches this dylib.
 *
 * It is recommended to call this once after `dlopen` / `LoadLibrary` to verify
 * the header and dylib agree on the major ABI version; a mismatch means they
 * are incompatible. No global state is initialised by this call — skipping it
 * does not prevent adapter functions from operating, but undetected ABI
 * mismatches may cause memory corruption. Returns `AD_RESULT_OK` when
 * `expected_major == AD_ABI_VERSION_MAJOR`. Returns
 * `AD_RESULT_ERR_INVALID_ARGS` with a diagnostic last-error when the version
 * does not match.
 */
AdResult ad_init(uint32_t expected_major);

/**
 * Low-level native-handle action. Dispatches directly to the platform adapter
 * without strict ref re-identification or actionability preflight. This is a
 * raw escape hatch for callers that already hold a live native handle. Callers
 * wanting CLI-semantics parity (RefStore load → strict resolution → preflight
 * → dispatch) should use `ad_execute_by_ref` instead.
 *
 * # Safety
 *
 * `adapter` must be a non-null pointer returned by `ad_adapter_create`.
 * `handle` must be a non-null pointer to a valid `AdNativeHandle` produced by
 * the same live adapter. Free the handle before destroying that adapter.
 * `action` must be a non-null pointer to a valid `AdAction`.
 * `out` must be a non-null pointer to an `AdActionResult` to write the result into.
 *
 * Handles come from exact resolvers and already carry process-generation
 * evidence, so this executes under the same policy as
 * `ad_execute_action_with_policy`.
 */
AdResult ad_execute_action(const struct AdAdapter *adapter,
                           const struct AdNativeHandle *handle,
                           const struct AdAction *action,
                           struct AdActionResult *out);

/**
 * Low-level native-handle action with explicit interaction policy. Dispatches
 * directly to the platform adapter without strict ref re-identification or
 * actionability preflight. The `policy` discriminant is applied verbatim — no
 * base-policy elevation is performed. This is a raw escape hatch for callers
 * that already hold a live native handle. Callers wanting CLI-semantics parity
 * (RefStore load → strict resolution → preflight → dispatch with base-policy
 * join) should use `ad_execute_by_ref` instead.
 *
 * # Safety
 *
 * `adapter` must be a non-null pointer returned by `ad_adapter_create`.
 * `handle` must be a non-null pointer to a valid `AdNativeHandle` produced by
 * the same live adapter. Free the handle before destroying that adapter.
 * `action` must be a non-null pointer to a valid `AdAction`.
 * `out` must be a non-null pointer to an `AdActionResult` to write the result into.
 */
AdResult ad_execute_action_with_policy(const struct AdAdapter *adapter,
                                       const struct AdNativeHandle *handle,
                                       const struct AdAction *action,
                                       int32_t policy,
                                       struct AdActionResult *out);

/**
 * Executes a struct-based ref action with exact process-generation and typed
 * native-id evidence.
 *
 * # Safety
 *
 * All pointers must be valid. `entry` must carry the current exact-entry
 * version and size. `out` is zeroed before any fallible operation.
 */
AdResult ad_execute_ref_action_exact_with_policy(const struct AdAdapter *adapter,
                                                 const struct AdExactRefEntry *entry,
                                                 const struct AdAction *action,
                                                 int32_t policy,
                                                 struct AdActionResult *out);

/**
 * Releases a handle previously returned by an exact resolver and
 * zeroes the caller's struct so accidentally calling this twice is
 * a deterministic no-op instead of dropping its owned payload twice.
 *
 * `AdNativeHandle.ptr` is an opaque registry token, not an operating-system
 * or Rust allocation address. Removing it releases the platform payload.
 *
 * Ownership contract: the FFI owns the handle from the moment a resolver
 * writes `ptr`. Copying the struct after that point is unsupported. Releasing
 * the original zeroes it and makes a second release of that same struct a
 * no-op; releasing an unzeroed copy is rejected.
 *
 * # Safety
 *
 * `adapter` must be a non-null pointer returned by `ad_adapter_create`.
 * It must identify the same adapter that created the handle. The adapter may
 * already have been destroyed; handles remain independently owned until freed.
 * `handle` must be null or a `*mut AdNativeHandle` previously populated by an
 * exact resolver on the calling thread. On return `(*handle).ptr` is
 * `NULL` so a double-call is a no-op instead of a double-free.
 */
AdResult ad_free_handle(const struct AdAdapter *adapter, struct AdNativeHandle *handle);

/**
 * Resolves an element using process-generation and typed native-id evidence.
 *
 * # Safety
 *
 * `adapter` and `entry` must be live and valid; `out` must be writable.
 */
AdResult ad_resolve_element_exact(const struct AdAdapter *adapter,
                                  const struct AdExactRefEntry *entry,
                                  struct AdNativeHandle *out);

/**
 * # Safety
 *
 * `result` must be null or a pointer to an `AdActionResult` previously written
 * by `ad_execute_action`, `ad_execute_action_with_policy`,
 * `ad_execute_ref_action_exact_with_policy`, or `ad_notification_action`. This frees
 * `post_state`, `steps`, and all nested strings. After this call all pointers
 * inside the struct are invalid.
 */
void ad_free_action_result(struct AdActionResult *result);

/**
 * Builds a platform adapter for the current OS and returns an opaque
 * handle. Returns null on allocation failure or if a Rust panic is
 * caught at the FFI boundary (inspect `ad_last_error_*` for details).
 *
 * The returned pointer is owned by the caller and must be released with
 * `ad_adapter_destroy`. Creating and destroying adapters is cheap; the
 * common pattern is one adapter per process lifetime.
 */
struct AdAdapter *ad_adapter_create(void);

/**
 * Builds a session-scoped platform adapter. `session` may be:
 * - null: equivalent to `ad_adapter_create()` (no session).
 * - a valid session id (1-64 ASCII alphanumeric / `-` / `_` chars): associates
 *   the adapter with that session for refmap persistence.
 * - empty, too long, containing invalid characters, or invalid UTF-8: sets
 *   `ErrInvalidArgs` in the last-error slot and returns null; no adapter is
 *   allocated.
 *
 * The returned pointer must be released with `ad_adapter_destroy`.
 *
 * # Safety
 *
 * `session` must be null or point to readable memory that is NUL-terminated
 * within `AD_MAX_STRING_BYTES + 1` bytes.
 */
struct AdAdapter *ad_adapter_create_with_session(const char *session);

/**
 * # Safety
 *
 * `adapter` must be a pointer returned by `ad_adapter_create` or
 * `ad_adapter_create_with_session`, or null. After this call the pointer
 * is invalid and must not be used.
 *
 * Calls that acquired the adapter before destruction retain it until they
 * return. Calls beginning after destruction fail with `ErrInvalidArgs`.
 */
void ad_adapter_destroy(struct AdAdapter *adapter);

/**
 * # Safety
 *
 * `adapter` must be a non-null pointer returned by `ad_adapter_create` that
 * has not yet been destroyed.
 */
AdResult ad_check_permissions(const struct AdAdapter *adapter);

/**
 * Closes the application identified by `id` (bundle id on macOS,
 * executable path on other platforms). `force = true` skips the
 * graceful-shutdown path, terminates matching app processes, and escalates
 * survivors when the platform supports it. Session-critical processes
 * (for example loginwindow and Dock on macOS, csrss.exe and winlogon.exe
 * on Windows) are refused with `AD_RESULT_ERR_INVALID_ARGS` — the protected-process
 * guard is enforced inside the adapter, so FFI and CLI behave
 * identically.
 *
 * # Safety
 * `adapter` must be non-null. `id` must be a non-null UTF-8 C string.
 */
AdResult ad_close_app(const struct AdAdapter *adapter, const char *id, bool force);

/**
 * Launches the application identified by `id` (bundle id on macOS,
 * executable path on other platforms) and, on success, writes the first
 * generation-pinned window that becomes available into `*out`. Waits for the
 * windows the launch itself produces, bounded by `timeout_ms`; zero means
 * "no wait". An application that presents no window fails with
 * `WINDOW_NOT_FOUND`.
 *
 * The returned `AdExactWindowInfo` owns heap-allocated interior strings that
 * must be released with `ad_release_exact_window_fields` once done. On error
 * the out-param is zero-initialized, so calling the release fn on it is a
 * safe no-op.
 *
 * # Safety
 * `adapter` must be non-null. `id` must be a non-null UTF-8 C string.
 * `out` must be a non-null writable `*mut AdExactWindowInfo`.
 */
AdResult ad_launch_app_exact(const struct AdAdapter *adapter,
                             const char *id,
                             uint64_t timeout_ms,
                             struct AdExactWindowInfo *out);

/**
 * # Safety
 * `adapter` must be a valid pointer from `ad_adapter_create`.
 * `out` must be a valid writable `*mut *mut AdAppList`.
 * On success, `*out` is a newly-allocated opaque list freed with
 * `ad_app_list_free`. On error, `*out` is null and last-error is set.
 */
AdResult ad_list_apps(const struct AdAdapter *adapter, struct AdAppList **out);

/**
 * # Safety
 * `list` must be null or a pointer returned by `ad_list_apps`.
 */
uint32_t ad_app_list_count(const struct AdAppList *list);

/**
 * Returns a borrowed pointer into the list; valid until the list is freed.
 * Out-of-range `index` returns null.
 *
 * # Safety
 * `list` must be null or a pointer returned by `ad_list_apps`.
 */
const struct AdAppInfo *ad_app_list_get(const struct AdAppList *list, uint32_t index);

/**
 * Frees the list and every `AdAppInfo` it owns, including the interior
 * C-strings.
 *
 * # Safety
 * `list` must be null or a pointer returned by `ad_list_apps`.
 */
void ad_app_list_free(struct AdAppList *list);

/**
 * Drives a snapshot-qualified ref action (`@<snapshot_id>:e5`, action)
 * through the canonical ref-action
 * pipeline: `RefStore` load → `RefMap` lookup (→ `STALE_REF` on missing) →
 * strict element resolution (→ `STALE_REF`/`AMBIGUOUS_TARGET`) → live
 * actionability preflight → dispatch → owned-handle drop.
 *
 * Policy: semantic actions, including `TypeText`, default to strict
 * `headless`. Explicit `PressKey` defaults to `focus_fallback`. A policy
 * discriminant may elevate to focus fallback or headed. Base and elevation
 * are computed by `agent_desktop_core::commands::execute_by_ref::execute_with_timeout` via
 * `Action::base_interaction_policy` + `InteractionPolicy::join`, so CLI and
 * FFI share a single source of policy truth.
 *
 * `ref_id` tri-state: null → `ErrInvalidArgs`; non-null invalid UTF-8 →
 * `ErrInvalidArgs`; valid UTF-8 that is not a snapshot-qualified
 * `@<snapshot_id>:e{N}` ref, including a bare `@e{N}` → `ErrInvalidArgs`.
 *
 * `policy` is an `AdPolicyKind` discriminant (0=Headless, 1=FocusFallback,
 * 2=Headed). An out-of-range value returns `ErrInvalidArgs`. `Headless (0)`
 * accepts the action's base policy. `FocusFallback (1)` explicitly permits
 * focus without cursor movement. `Headed (2)` opts in to physical cursor and
 * keyboard delivery.
 *
 * Uses a fixed 5000ms auto-wait budget before
 * the actionability preflight, matching the CLI default. Call
 * `ad_execute_by_ref_timeout` with an explicit `timeout_ms` (-1 = default,
 * 0 = single-shot with no auto-wait) to control this.
 *
 * On success `*out` is set to a NUL-terminated JSON envelope (command
 * `"execute_by_ref"`); free with `ad_free_string`. On guard or decode
 * failure (invalid args before the command runs) `*out` remains null.
 * On a command-level error (STALE_REF, AMBIGUOUS_TARGET, etc.) `*out`
 * holds the error JSON envelope and must still be freed with
 * `ad_free_string`. The last-error slot is populated on all failures.
 *
 * **Dispatch-before-serialize ordering**: the action is dispatched (and any
 * side effects committed) before the result JSON is serialized. In the
 * near-impossible event that serialization of an already-valid
 * `ActionResult` fails, `*out` is null and `ErrInternal` is returned while
 * the side effect has already occurred. No pre-validation machinery is
 * needed because serialization of a valid envelope effectively never fails.
 *
 * # Safety
 *
 * `adapter` must be a non-null pointer from `ad_adapter_create[_with_session]`.
 * `ref_id` must be a non-null pointer to a NUL-terminated C string within
 * `AD_MAX_STRING_BYTES + 1` bytes; null is **not** optional — it is defined
 * behaviour (no UB) but is rejected immediately with `ErrInvalidArgs`.
 * `action`
 * must be a non-null pointer to a
 * valid `AdAction`. `out` must be a non-null writable pointer. All pointers
 * must remain valid for the duration of the call. Must be called from the
 * calling thread.
 */
AdResult ad_execute_by_ref(const struct AdAdapter *adapter,
                           const char *ref_id,
                           const struct AdAction *action,
                           int32_t policy,
                           char **out);

/**
 * Same as `ad_execute_by_ref` but with an explicit pre-action auto-wait
 * budget in milliseconds. `timeout_ms == -1` uses the 5000ms default and
 * `timeout_ms == 0` disables auto-wait for a single-shot preflight.
 *
 * # Safety
 *
 * Same pointer and threading requirements as `ad_execute_by_ref`.
 */
AdResult ad_execute_by_ref_timeout(const struct AdAdapter *adapter,
                                   const char *ref_id,
                                   const struct AdAction *action,
                                   int32_t policy,
                                   int64_t timeout_ms,
                                   char **out);

/**
 * Takes a full CLI-format snapshot of the target application window,
 * allocates snapshot-qualified refs (`@<snapshot_id>:eN`) for all
 * interactive elements, persists the refmap to disk, and writes the JSON envelope into `*out`.
 *
 * The JSON shape matches `agent-desktop snapshot`:
 * `{"version":"2.5","ok":true,"command":"snapshot","data":{"app":"...","window":{...},"ref_count":N,"snapshot_id":"...","complete":true,"tree":{...}}}`.
 *
 * `data.complete` is always present. A snapshot that exhausts its observation
 * budget still succeeds with `"complete":false` and the tree it did observe,
 * and then also carries `"truncated":true` and `"nodes_observed":N`; each node
 * whose descendants were cut short carries `"subtree_truncated":true`, a field
 * that is emitted only when true. Callers must read `complete` to decide
 * whether a tree is whole — an incomplete observation is not reported as a
 * `TIMEOUT` error.
 *
 * **`*out` ownership and error behaviour:**
 * - On success (`AD_RESULT_OK`): `*out` is a heap-allocated JSON string with `"ok":true`.
 *   Caller must free it with `ad_free_string`.
 * - On a command-level error (e.g. app not found, snapshot failure): `*out` is a
 *   heap-allocated JSON string with `"ok":false` and an `"error"` payload. Caller
 *   must still free it with `ad_free_string`. The last-error slot is also set.
 * - On an argument or infrastructure error (null adapter, invalid
 *   UTF-8, bad surface discriminant, context failure): `*out` is set to null and no
 *   allocation is made. Only the last-error slot is set.
 *
 * `app` is tri-state:
 * - null — snapshot the currently focused window (same as running the command with no `--app`).
 * - valid UTF-8 string — snapshot the named application's focused window.
 * - non-null but invalid UTF-8 or exceeding `AD_MAX_STRING_BYTES` — returns `ErrInvalidArgs`.
 *
 * `surface` is an `AdSnapshotSurface` discriminant (0 = Window, 1 = Focused, …).
 * An out-of-range value returns `ErrInvalidArgs`.
 *
 * This entrypoint always targets the active focused window of the requested
 * application; explicit window targeting (`window_id`) is not yet exposed
 * over the ABI. Progressive traversal (skeleton mode and `--root` drill-down)
 * is likewise not exposed here. Both are planned fast-follows to this
 * entrypoint — agents needing them should use the CLI in the meantime.
 *
 * **Dispatch-before-serialize ordering**: the snapshot and refmap persistence
 * occur before the result JSON is serialised. In the near-impossible event
 * that serialisation of an already-valid result fails, `*out` is set to null
 * and `ErrInternal` is returned while the refmap is already written.
 *
 * # Safety
 *
 * `adapter` must be a non-null pointer from `ad_adapter_create` or
 * `ad_adapter_create_with_session`. `out` must be a non-null writable
 * `*mut *mut c_char`. `app` must be null or a NUL-terminated string within
 * `AD_MAX_STRING_BYTES + 1` bytes. All pointers must remain valid for the
 * duration of the call.
 */
AdResult ad_snapshot(const struct AdAdapter *adapter,
                     const char *app,
                     int32_t surface,
                     uint8_t max_depth,
                     bool interactive_only,
                     bool compact,
                     char **out);

/**
 * Returns the adapter's current health and permission state as a JSON
 * envelope matching the `agent-desktop status` CLI output.
 *
 * `ad_status` does not query the accessibility tree; it reads the
 * permission report and ref-store metadata only. Like other adapter
 * entrypoints, it may be called from any host thread. On success `*out` is a
 * NUL-terminated, heap-allocated JSON string freed with `ad_free_string`.
 *
 * On a command-level failure `*out` is set to a heap-allocated JSON string
 * with `"ok":false` and an `"error"` payload. The caller must still release
 * it with `ad_free_string(*out)`. The last-error slot is also set.
 *
 * On an argument or infrastructure failure (null adapter, null out, context
 * error) `*out` is zeroed and only the last-error slot is populated.
 *
 * # Safety
 *
 * `adapter` must be a non-null pointer returned by `ad_adapter_create`
 * that has not been destroyed. `out` must be a non-null writable
 * `*mut *mut c_char`.
 */
AdResult ad_status(const struct AdAdapter *adapter, char **out);

/**
 * Exports the merged trace timeline for the adapter's active session as a
 * single self-contained HTML file matching `agent-desktop trace export`.
 *
 * `limit` controls tail semantics: `0` embeds all events; the default `5000`
 * matches the CLI. Pass `-1` to use the CLI default explicitly.
 *
 * `out_path` may be null; when set it must be a NUL-terminated UTF-8 path
 * within `AD_MAX_STRING_BYTES + 1` bytes.
 *
 * On success `*out` is a heap-allocated JSON envelope freed with
 * `ad_free_string`. On command-level failure `*out` still holds an error
 * envelope that must be freed.
 *
 * # Safety
 *
 * `adapter` must be a non-null pointer from `ad_adapter_create` or
 * `ad_adapter_create_with_session`. `out` must be non-null. `out_path`
 * may be null or a NUL-terminated UTF-8 string within `AD_MAX_STRING_BYTES + 1`
 * bytes.
 */
AdResult ad_trace_export(const struct AdAdapter *adapter,
                         int32_t limit,
                         const char *out_path,
                         char **out);

/**
 * Returns the merged trace timeline for the adapter's active session as a
 * JSON envelope matching `agent-desktop trace show`.
 *
 * `limit` controls tail semantics: `0` embeds all events; the default `500`
 * matches the CLI. Pass `-1` to use the CLI default explicitly.
 *
 * `event_prefix` may be null; when set, only events whose name starts with the
 * prefix are returned before the tail limit is applied.
 *
 * On success `*out` is a heap-allocated JSON envelope freed with
 * `ad_free_string`. On command-level failure `*out` still holds an error
 * envelope that must be freed.
 *
 * # Safety
 *
 * `adapter` must be a non-null pointer from `ad_adapter_create` or
 * `ad_adapter_create_with_session`. `out` must be non-null. `event_prefix`
 * may be null or a NUL-terminated UTF-8 string within `AD_MAX_STRING_BYTES + 1`
 * bytes.
 */
AdResult ad_trace_show(const struct AdAdapter *adapter,
                       int32_t limit,
                       const char *event_prefix,
                       char **out);

/**
 * Returns the `agent-desktop` version envelope as an owned JSON C string.
 *
 * The returned string has the same `{version, ok, command, data}` shape
 * as `agent-desktop version` on the CLI. Free it with `ad_free_string`.
 *
 * On success `*out` points to the envelope JSON.
 * On error `*out` is null and the last-error slot is populated.
 *
 * # Safety
 * `out` must be a non-null writable `*mut *mut c_char`.
 */
AdResult ad_version(char **out);

/**
 * Runs `wait` with the given args, blocking the calling thread until the
 * condition is met or `timeout_ms` elapses.
 *
 * On success `*out` is set to a freshly allocated JSON string containing the
 * CLI-format wait envelope (`{version, ok, command, data}`). The caller must
 * release the string with `ad_free_string(*out)`.
 *
 * On a command-level failure (e.g. `TIMEOUT`, `ELEMENT_NOT_FOUND`) `*out` is
 * set to a freshly allocated JSON string with `"ok":false` and an `"error"`
 * payload. The caller must still release it with `ad_free_string(*out)`. The
 * last-error slot is also set.
 *
 * On an argument or infrastructure failure (null adapter, null args, null out,
 * invalid UTF-8 field) `*out` is zeroed, the last-error slot
 * is set, and a negative `AdResult` code is returned. No allocation is made.
 *
 * # Safety
 *
 * `adapter` must be a non-null pointer returned by `ad_adapter_create` that
 * has not been destroyed. `args` must be non-null and point to a valid
 * zero-initialized `AdWaitArgs`. `out` must be non-null and point to a
 * writable `*mut c_char`.
 *
 * All `*const c_char` fields inside `AdWaitArgs` must be null or point to
 * readable, NUL-terminated memory within `AD_MAX_STRING_BYTES + 1` bytes.
 *
 * `ad_wait` retains the adapter while blocked. Concurrent destruction revokes
 * the opaque adapter token for new calls without invalidating this call.
 */
AdResult ad_wait(const struct AdAdapter *adapter, const struct AdWaitArgs *args, char **out);

/**
 * Lists displays in screenshot screen-index order.
 *
 * # Safety
 * `adapter` must be valid and `out` must be writable. Success produces an
 * opaque list freed with `ad_display_list_free`.
 */
AdResult ad_list_displays(const struct AdAdapter *adapter, struct AdDisplayList **out);

/**
 * # Safety
 * `list` must be null or returned by `ad_list_displays`.
 */
uint32_t ad_display_list_count(const struct AdDisplayList *list);

/**
 * Returns a borrowed display entry, or null when `index` is out of range.
 *
 * # Safety
 * `list` must be null or returned by `ad_list_displays`.
 */
const struct AdDisplayInfo *ad_display_list_get(const struct AdDisplayList *list, uint32_t index);

/**
 * # Safety
 * `list` must be null or returned by `ad_list_displays`.
 */
void ad_display_list_free(struct AdDisplayList *list);

/**
 * Last-error lifetime — errno-style.
 *
 * The pointer returned by `ad_last_error_message`,
 * `ad_last_error_suggestion`, and `ad_last_error_platform_detail`
 * remains valid across any number of subsequent **successful** FFI
 * calls on the same thread. Only the next FFI call that itself **fails**
 * (returns a non-`AD_RESULT_OK` code) invalidates the previous pointers.
 *
 * Consumers can therefore read an error once, cache the pointer, and
 * keep reading it back across follow-up work that clears or re-fetches
 * state before handing control to the user.
 *
 * This matches the POSIX `errno` / `strerror` contract and is scoped
 * per-thread via thread-local storage — Thread A's last-error never
 * leaks to Thread B.
 * Returns the `AdResult` code of the last error on the calling thread,
 * or `AD_RESULT_OK` if no error has been recorded.
 */
AdResult ad_last_error_code(void);

/**
 * Returns a borrowed C string describing the last error, or null if no
 * error has been recorded on the calling thread. The pointer remains
 * valid across any number of subsequent *successful* FFI calls; only
 * the next failing call overwrites it.
 */
const char *ad_last_error_message(void);

/**
 * Returns a borrowed C string with a human-readable suggestion for how
 * to recover from the last error, or null if the adapter didn't emit
 * one. Same lifetime rules as `ad_last_error_message`.
 */
const char *ad_last_error_suggestion(void);

/**
 * Returns a borrowed C string carrying a platform-specific diagnostic
 * for the last error (AX error codes, COM HRESULTs, AT-SPI messages,
 * etc.), or null if the adapter didn't supply one. Same lifetime rules
 * as `ad_last_error_message`.
 */
const char *ad_last_error_platform_detail(void);

/**
 * Returns a borrowed JSON string carrying structured details for the last
 * error, or null if the adapter didn't supply any. Same lifetime rules as
 * `ad_last_error_message`. Details may contain element names, values, and
 * window titles from the user's screen; treat as sensitive diagnostics and
 * avoid routing to shared log surfaces.
 */
const char *ad_last_error_details(void);

/**
 * Writes the delivery and retry semantics associated with the calling
 * thread's last error. If no error has been recorded, both values are
 * `UNKNOWN`. This successful read does not clear or replace last-error state.
 *
 * # Safety
 *
 * `out` must point to writable `AdDeliverySemantics` storage.
 */
AdResult ad_last_error_delivery_semantics(struct AdDeliverySemantics *out);

/**
 * Reads the current clipboard text and writes an owned C string into
 * `*out`. The caller must free the returned pointer with
 * `ad_free_string`. On error `*out` is left null.
 *
 * # Safety
 * `adapter` must be a non-null pointer returned by `ad_adapter_create`.
 * `out` must be a non-null writable `*mut *mut c_char`.
 */
AdResult ad_get_clipboard(const struct AdAdapter *adapter, char **out);

/**
 * Writes UTF-8 `text` to the clipboard. Null or non-UTF-8 input returns
 * `AD_RESULT_ERR_INVALID_ARGS` with a diagnostic last-error.
 *
 * # Safety
 * `adapter` must be a non-null pointer returned by `ad_adapter_create`.
 * `text` must be a non-null, NUL-terminated UTF-8 C string.
 */
AdResult ad_set_clipboard(const struct AdAdapter *adapter, const char *text);

/**
 * Clears the clipboard.
 *
 * # Safety
 * `adapter` must be a non-null pointer returned by `ad_adapter_create`.
 */
AdResult ad_clear_clipboard(const struct AdAdapter *adapter);

/**
 * Frees a C string previously returned by `ad_get_clipboard` or any
 * other FFI call documented as allocating a C string for the caller.
 * Null-tolerant. Unknown pointers and repeated frees are ignored.
 *
 * # Safety
 * `s` may be null or a pointer previously handed out by this crate.
 * After a successful free the pointer is invalid and must not be used.
 */
void ad_free_string(char *s);

/**
 * Synthesizes an explicit physical mouse drag from `params.from` to
 * `params.to`. When `params.duration_ms` is zero the drag is instantaneous;
 * a non-zero value asks the platform adapter to interpolate. Callers that
 * need headless policy enforcement should use ref actions with policy.
 *
 * # Safety
 * `adapter` must be a non-null pointer returned by `ad_adapter_create`.
 * `params` must be a non-null pointer to a valid `AdDragParams`.
 */
AdResult ad_drag(const struct AdAdapter *adapter, const struct AdDragParams *params);

/**
 * Dispatches an explicit physical mouse event (move / down / up / click)
 * at the given screen point. Click count is only consulted when `event.kind`
 * is `CLICK` (e.g., `click_count == 2` for a double-click). Callers that
 * need headless policy enforcement should use ref actions with policy.
 * Carries no modifier chord — use [`ad_mouse_event_with_modifiers`] for
 * meta/ctrl/alt/shift-held clicks.
 *
 * # Safety
 * `adapter` must be a non-null pointer returned by `ad_adapter_create`.
 * `event` must be a non-null pointer to a valid `AdMouseEvent`.
 */
AdResult ad_mouse_event(const struct AdAdapter *adapter, const struct AdMouseEvent *event);

/**
 * Additive counterpart to [`ad_mouse_event`] that also carries a held
 * modifier chord (meta/ctrl/alt/shift) — e.g. Meta-click for additive
 * selection, shift-click for range selection. `AdMouseEvent`'s layout is
 * unchanged; modifiers travel as a separate array + count, mirroring
 * `AdKeyCombo::modifiers`/`modifier_count`.
 *
 * # Safety
 * `adapter` must be a non-null pointer returned by `ad_adapter_create`.
 * `event` must be a non-null pointer to a valid `AdMouseEvent`.
 * `modifiers` must point to `modifier_count` valid `int32_t` values, or be
 * null when `modifier_count` is 0.
 */
AdResult ad_mouse_event_with_modifiers(const struct AdAdapter *adapter,
                                       const struct AdMouseEvent *event,
                                       const int32_t *modifiers,
                                       uint32_t modifier_count);

/**
 * Dispatches a physical wheel event using platform-neutral line deltas.
 * Positive `delta_y` scrolls up and negative scrolls down; positive
 * `delta_x` scrolls left and negative scrolls right. `modifier_mask` uses
 * bits 0-3 for meta, ctrl, alt, and shift respectively.
 *
 * # Safety
 * `adapter` must be a non-null pointer returned by `ad_adapter_create`.
 */
AdResult ad_mouse_wheel(const struct AdAdapter *adapter,
                        struct AdPoint point,
                        double delta_x,
                        double delta_y,
                        uint32_t modifier_mask);

/**
 * Registers or clears the callback used for events emitted synchronously
 * inside later `ad_*` calls on the same thread.
 *
 * The callback may be invoked concurrently by different host threads. The
 * message pointer is valid only until the callback returns. The callback must
 * not unwind across this C ABI boundary; C++ exceptions and Rust panics must
 * be caught inside the callback. Violating that contract may abort the host.
 */
AdResult ad_set_log_callback(void (*callback)(int32_t level, const char *msg));

/**
 * Triggers the named action on the notification at `index`. Typical
 * action names are those reported in `AdNotificationInfo.actions`
 * (e.g. `"Reply"`, `"Open"`).
 *
 * ## Identity / reorder safety
 *
 * Notification Center reindexes entries on every listing — a new
 * notification arriving (or another one being dismissed) shifts which
 * notification sits at any given `index`. Calling this function with
 * an index obtained from a prior `ad_list_notifications` can therefore
 * press the action button on a different notification than the host
 * intended.
 *
 * `request.identity` pins the target to an observed fingerprint. At least one
 * identity field is required; a mismatch fails closed with
 * `AD_RESULT_ERR_NOTIFICATION_NOT_FOUND`.
 *
 * # Safety
 * `adapter` and `request` must be valid. `request.action_name` must be a
 * non-null UTF-8 C string. Identity fields must each be null or a
 * NUL-terminated UTF-8 C string. Invalid UTF-8 in either field
 * is rejected with `AD_RESULT_ERR_INVALID_ARGS` rather than silently
 * treated as "no fingerprint". `out` must be a valid writable
 * `*mut AdActionResult`; on error it is zero-initialized.
 */
AdResult ad_notification_action(const struct AdAdapter *adapter,
                                const struct AdNotificationActionRequest *request,
                                struct AdActionResult *out);

/**
 * Dismisses a notification only when the current row matches an identity
 * observed in the same listing. At least one expected field is required.
 *
 * # Safety
 * `adapter` must be valid. String pointers may be null and otherwise must be
 * NUL-terminated UTF-8.
 */
AdResult ad_dismiss_notification(const struct AdAdapter *adapter,
                                 uint32_t index,
                                 const char *app_filter,
                                 const char *expected_app,
                                 const char *expected_title);

/**
 * Dismisses every notification matching `app_filter` (null = all apps).
 *
 * Returns two lists: `dismissed_out` carries the notifications that
 * were successfully dismissed; `failed_out` holds error strings for
 * notifications where the platform rejected the dismiss. Partial
 * failures do not set last-error — inspect `failed_out` for details.
 *
 * `failed_out` uses the notification-list handle to stay ABI-consistent
 * with the other list-returning FFI calls; the entries carry the
 * original notification shape with `body` populated by the platform
 * error message.
 *
 * # Safety
 * `adapter` must be valid. `app_filter` may be null. `dismissed_out`
 * and `failed_out` must both be valid writable `*mut *mut AdNotificationList`.
 */
AdResult ad_dismiss_all_notifications(const struct AdAdapter *adapter,
                                      const char *app_filter,
                                      struct AdNotificationList **dismissed_out,
                                      struct AdNotificationList **failed_out);

/**
 * Convenience wrapper: free both lists returned by
 * `ad_dismiss_all_notifications`. Equivalent to calling
 * `ad_notification_list_free` on each; provided for symmetry.
 *
 * # Safety
 * Both arguments must be null or pointers from
 * `ad_dismiss_all_notifications`.
 */
void ad_dismiss_all_notifications_free(struct AdNotificationList *dismissed,
                                       struct AdNotificationList *failed);

/**
 * Lists the notifications currently on-screen.
 *
 * Notification indexes are only stable within a single list response. Pass
 * the entry's app or title fingerprint to the checked mutation functions;
 * index-only mutations are rejected.
 *
 * # Safety
 * `adapter` must be valid. `filter` may be null. `out` must be a valid
 * writable `*mut *mut AdNotificationList`. On success `*out` is a
 * non-null handle freed with `ad_notification_list_free`.
 */
AdResult ad_list_notifications(const struct AdAdapter *adapter,
                               const struct AdNotificationFilter *filter,
                               struct AdNotificationList **out);

/**
 * # Safety
 * `list` must be null or a pointer returned by `ad_list_notifications`.
 */
uint32_t ad_notification_list_count(const struct AdNotificationList *list);

/**
 * Borrows a notification entry. Null if `index` is out of range.
 *
 * # Safety
 * `list` must be null or a pointer returned by `ad_list_notifications`.
 */
const struct AdNotificationInfo *ad_notification_list_get(const struct AdNotificationList *list,
                                                          uint32_t index);

/**
 * Frees the list and each entry's interior strings.
 *
 * # Safety
 * `list` must be null or a pointer returned by `ad_list_notifications`.
 */
void ad_notification_list_free(struct AdNotificationList *list);

/**
 * Finds and strictly resolves one element within a generation-pinned window.
 * `AdFindQuery.control.selection` must explicitly request first, last, or nth
 * behavior when duplicate matches are acceptable. The returned native handle
 * is adapter-bound and thread-affine; release it with `ad_free_handle` on the
 * resolving thread.
 *
 * # Safety
 * All pointers must be valid and `out_handle` must be writable.
 */
AdResult ad_find_exact(const struct AdAdapter *adapter,
                       const struct AdExactWindowInfo *win,
                       const struct AdFindQuery *query,
                       struct AdNativeHandle *out_handle);

/**
 * Reads a single property off a previously-resolved element handle.
 *
 * Supported properties:
 * - `"value"`  — live textual value (text fields, sliders, progress
 *   indicators). Null out-string when the element has no value.
 * - `"bounds"` — JSON-encoded `{"x":..,"y":..,"width":..,"height":..}`.
 *   Null out-string when bounds are unavailable.
 *
 * The returned string must be freed with `ad_free_string`.
 *
 * # Safety
 * `adapter` must be valid. `handle` must be a non-null `AdNativeHandle`
 * produced by the same live adapter and freed before that adapter is destroyed.
 * `property` must be a non-null UTF-8 C string. `out` must be a valid
 * writable `*mut *mut c_char`; it is null-initialized on entry.
 */
AdResult ad_get(const struct AdAdapter *adapter,
                const struct AdNativeHandle *handle,
                const char *property,
                char **out);

/**
 * Checks a boolean state within a generation-pinned exact window.
 *
 * # Safety
 * All pointers must be valid and `out` must be writable.
 */
AdResult ad_is_exact(const struct AdAdapter *adapter,
                     const struct AdExactWindowInfo *win,
                     const struct AdFindQuery *query,
                     const char *property,
                     bool *out);

#if defined(AGENT_DESKTOP_TEST_PANIC_INJECTION)
AdResult ad_test_panic_boundary(void);
#endif

/**
 * Borrowed pointer to the image bytes; valid until the buffer is freed.
 * Returns null if `buf` is null.
 *
 * # Safety
 * `buf` must be null or returned by `ad_screenshot`.
 */
const uint8_t *ad_image_buffer_data(const struct AdImageBuffer *buf);

/**
 * Byte length of the buffer returned by `ad_image_buffer_data`.
 * Always consistent with the actual allocation (no C-mutable mismatch).
 *
 * # Safety
 * `buf` must be null or returned by `ad_screenshot`.
 */
uint64_t ad_image_buffer_size(const struct AdImageBuffer *buf);

/**
 * Pixel width of the image.
 *
 * # Safety
 * `buf` must be null or returned by `ad_screenshot`.
 */
uint32_t ad_image_buffer_width(const struct AdImageBuffer *buf);

/**
 * Pixel height of the image.
 *
 * # Safety
 * `buf` must be null or returned by `ad_screenshot`.
 */
uint32_t ad_image_buffer_height(const struct AdImageBuffer *buf);

/**
 * Encoding format of the image bytes. Defaults to `PNG` on a null
 * handle — callers must still null-check.
 *
 * # Safety
 * `buf` must be null or returned by `ad_screenshot`.
 */
AdImageFormat ad_image_buffer_format(const struct AdImageBuffer *buf);

/**
 * Point-to-pixel scale factor for the captured display or window.
 *
 * # Safety
 * `buf` must be null or returned by `ad_screenshot`.
 */
double ad_image_buffer_scale_factor(const struct AdImageBuffer *buf);

/**
 * Allocates and returns an opaque `AdImageBuffer`. The handle owns its
 * byte buffer; inspect it through `ad_image_buffer_data` /
 * `ad_image_buffer_size` / `ad_image_buffer_format` / `_width` / `_height`
 * and free it with `ad_image_buffer_free`.
 *
 * # Safety
 * `adapter` and `target` must be valid pointers. `out` must be a valid
 * writable `*mut *mut AdImageBuffer`. On error `*out` is null and
 * last-error is set.
 */
AdResult ad_screenshot(const struct AdAdapter *adapter,
                       const struct AdScreenshotTarget *target,
                       struct AdImageBuffer **out);

/**
 * Captures one generation-pinned exact window.
 *
 * # Safety
 * `adapter`, `window`, and `out` must be valid pointers. The returned image
 * must be freed with `ad_image_buffer_free`.
 */
AdResult ad_screenshot_window_exact(const struct AdAdapter *adapter,
                                    const struct AdExactWindowInfo *window,
                                    struct AdImageBuffer **out);

/**
 * Frees the image buffer allocated by `ad_screenshot`.
 *
 * # Safety
 * `buf` must be null or a pointer previously returned by `ad_screenshot`.
 * Double-free is undefined behavior.
 */
void ad_image_buffer_free(struct AdImageBuffer *buf);

/**
 * Lists surfaces without dropping their core surface IDs.
 *
 * # Safety
 * `adapter` and `out` must be valid. The returned list must be freed with
 * `ad_exact_surface_list_free`.
 */
AdResult ad_list_surfaces_exact(const struct AdAdapter *adapter,
                                uint32_t pid,
                                struct AdExactSurfaceList **out);

/**
 * # Safety
 * `list` must be null or returned by `ad_list_surfaces_exact`.
 */
uint32_t ad_exact_surface_list_count(const struct AdExactSurfaceList *list);

/**
 * # Safety
 * `list` must be null or returned by `ad_list_surfaces_exact`. The result is
 * borrowed until the list is freed.
 */
const struct AdExactSurfaceInfo *ad_exact_surface_list_get(const struct AdExactSurfaceList *list,
                                                           uint32_t index);

/**
 * # Safety
 * `list` must be null or returned by `ad_list_surfaces_exact`.
 */
void ad_exact_surface_list_free(struct AdExactSurfaceList *list);

/**
 * # Safety
 * `tree` must be null or point to a valid `AdNodeTree` previously returned
 * by `flatten_tree` or `ad_get_tree_exact`. After this call the tree is zeroed.
 */
void ad_free_tree(struct AdNodeTree *tree);

/**
 * Snapshots a generation-pinned window into the flat, owned, breadth-first C
 * tree layout. Direct children are contiguous at
 * `nodes[child_start..child_start + child_count]`; free the result with
 * `ad_free_tree`.
 *
 * This is a raw adapter tree: nodes do not receive refs, no refmap is
 * persisted, and no JSON envelope is produced. `max_depth`, `surface`,
 * `include_bounds`, `interactive_only`, and `compact` are applied; skeleton
 * and drill-down behavior are not. Use `ad_snapshot` for the canonical
 * observe-act workflow with snapshot-qualified refs.
 *
 * # Safety
 * All pointers must be valid and `out` must be writable.
 */
AdResult ad_get_tree_exact(const struct AdAdapter *adapter,
                           const struct AdExactWindowInfo *win,
                           const struct AdTreeOptions *opts,
                           struct AdNodeTree *out);

size_t ad_action_size(void);

size_t ad_action_result_size(void);

size_t ad_action_step_size(void);

size_t ad_display_info_size(void);

size_t ad_drag_params_size(void);

size_t ad_element_state_size(void);

size_t ad_exact_ref_entry_size(void);

size_t ad_exact_surface_info_size(void);

size_t ad_exact_window_info_size(void);

size_t ad_ref_entry_size(void);

/**
 * Returns the size of `AdWaitArgs` as compiled. Ctypes and other
 * foreign bindings must call this and compare against their own
 * `sizeof` before passing args to `ad_wait`.
 */
size_t ad_wait_args_size(void);

/**
 * Focuses a generation-pinned exact window.
 *
 * # Safety
 * `adapter` and `win` must be valid pointers. `win` must carry the current
 * exact-window version and size.
 */
AdResult ad_focus_window_exact(const struct AdAdapter *adapter,
                               const struct AdExactWindowInfo *win);

/**
 * Releases every owned string inside one exact window value.
 *
 * # Safety
 * `win` must be null or point to a value written by `ad_launch_app_exact`.
 */
void ad_release_exact_window_fields(struct AdExactWindowInfo *win);

/**
 * Lists windows with explicit process-generation evidence.
 *
 * # Safety
 * `adapter` and `out` must be valid. `app_filter` may be null or a valid
 * bounded UTF-8 C string. The returned list must be freed with
 * `ad_exact_window_list_free`.
 */
AdResult ad_list_windows_exact(const struct AdAdapter *adapter,
                               const char *app_filter,
                               bool focused_only,
                               struct AdExactWindowList **out);

/**
 * # Safety
 * `list` must be null or returned by `ad_list_windows_exact`.
 */
uint32_t ad_exact_window_list_count(const struct AdExactWindowList *list);

/**
 * # Safety
 * `list` must be null or returned by `ad_list_windows_exact`. The returned
 * pointer is borrowed until the list is freed.
 */
const struct AdExactWindowInfo *ad_exact_window_list_get(const struct AdExactWindowList *list,
                                                         uint32_t index);

/**
 * # Safety
 * `list` must be null or returned by `ad_list_windows_exact`.
 */
void ad_exact_window_list_free(struct AdExactWindowList *list);

/**
 * Performs a window-manager operation against an exact generation-pinned
 * window identity.
 *
 * # Safety
 * `adapter` and `win` must be valid pointers. `win` must carry the current
 * exact-window version and size.
 */
AdResult ad_window_op_exact(const struct AdAdapter *adapter,
                            const struct AdExactWindowInfo *win,
                            struct AdWindowOp op);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus

#endif  /* AGENT_DESKTOP_H */

/* C11 ABI layout guards — auto-generated; do not hand-edit.
 * Each sizeof check references the AD_*_SIZE macro defined above so the
 * size literal lives in exactly one place (the Rust source). Alignment
 * and offset values are structurally fixed on all 64-bit targets.
 * The one-shot guard makes double-include safe regardless of C standard. */
#ifndef AGENT_DESKTOP_ABI_ASSERTS
#define AGENT_DESKTOP_ABI_ASSERTS
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(AdDragParams) == AD_DRAG_PARAMS_SIZE, "AdDragParams ABI size changed");
_Static_assert(_Alignof(AdDragParams) == 8, "AdDragParams ABI alignment changed");
_Static_assert(sizeof(AdAction) == AD_ACTION_SIZE, "AdAction ABI size changed");
_Static_assert(_Alignof(AdAction) == 8, "AdAction ABI alignment changed");
_Static_assert(sizeof(AdElementState) == AD_ELEMENT_STATE_SIZE, "AdElementState ABI size changed");
_Static_assert(_Alignof(AdElementState) == 8, "AdElementState ABI alignment changed");
_Static_assert(sizeof(AdActionStep) == AD_ACTION_STEP_SIZE, "AdActionStep ABI size changed");
_Static_assert(_Alignof(AdActionStep) == 8, "AdActionStep ABI alignment changed");
_Static_assert(offsetof(AdActionStep, label) == 0, "AdActionStep.label offset changed");
_Static_assert(offsetof(AdActionStep, outcome) == 8, "AdActionStep.outcome offset changed");
_Static_assert(offsetof(AdActionStep, mechanism) == 16, "AdActionStep.mechanism offset changed");
_Static_assert(offsetof(AdActionStep, has_mechanism) == 20, "AdActionStep.has_mechanism offset changed");
_Static_assert(offsetof(AdActionStep, verified) == 21, "AdActionStep.verified offset changed");
_Static_assert(offsetof(AdActionStep, has_verified) == 22, "AdActionStep.has_verified offset changed");
_Static_assert(sizeof(AdActionResult) == AD_ACTION_RESULT_SIZE, "AdActionResult ABI size changed");
_Static_assert(_Alignof(AdActionResult) == 8, "AdActionResult ABI alignment changed");
_Static_assert(offsetof(AdActionResult, action) == 0, "AdActionResult.action offset changed");
_Static_assert(offsetof(AdActionResult, ref_id) == 8, "AdActionResult.ref_id offset changed");
_Static_assert(offsetof(AdActionResult, post_state) == 16, "AdActionResult.post_state offset changed");
_Static_assert(offsetof(AdActionResult, steps) == 24, "AdActionResult.steps offset changed");
_Static_assert(offsetof(AdActionResult, step_count) == 32, "AdActionResult.step_count offset changed");
_Static_assert(offsetof(AdActionResult, details_json) == 40, "AdActionResult.details_json offset changed");
_Static_assert(offsetof(AdActionResult, disposition) == 48, "AdActionResult.disposition offset changed");
_Static_assert(sizeof(AdDeliverySemantics) == AD_DELIVERY_SEMANTICS_SIZE, "AdDeliverySemantics ABI size changed");
_Static_assert(offsetof(AdDeliverySemantics, retry) == 4, "AdDeliverySemantics.retry offset changed");
_Static_assert(sizeof(AdRefEntry) == AD_REF_ENTRY_SIZE, "AdRefEntry ABI size changed");
_Static_assert(_Alignof(AdRefEntry) == 8, "AdRefEntry ABI alignment changed");
_Static_assert(offsetof(AdRefEntry, process) == 0, "AdRefEntry.process offset changed");
_Static_assert(offsetof(AdRefEntry, identity) == 8, "AdRefEntry.identity offset changed");
_Static_assert(offsetof(AdRefEntry, geometry) == 48, "AdRefEntry.geometry offset changed");
_Static_assert(offsetof(AdRefEntry, capabilities) == 96, "AdRefEntry.capabilities offset changed");
_Static_assert(offsetof(AdRefEntry, source) == 128, "AdRefEntry.source offset changed");
_Static_assert(offsetof(AdRefEntry, scope) == 168, "AdRefEntry.scope offset changed");
_Static_assert(sizeof(AdExactRefEntry) == AD_EXACT_REF_ENTRY_SIZE, "AdExactRefEntry ABI size changed");
_Static_assert(_Alignof(AdExactRefEntry) == 8, "AdExactRefEntry ABI alignment changed");
_Static_assert(offsetof(AdExactRefEntry, version) == 0, "AdExactRefEntry.version offset changed");
_Static_assert(offsetof(AdExactRefEntry, size) == 4, "AdExactRefEntry.size offset changed");
_Static_assert(offsetof(AdExactRefEntry, entry) == 8, "AdExactRefEntry.entry offset changed");
_Static_assert(offsetof(AdExactRefEntry, process_instance) == 208, "AdExactRefEntry.process_instance offset changed");
_Static_assert(offsetof(AdExactRefEntry, identifier_kind) == 216, "AdExactRefEntry.identifier_kind offset changed");
_Static_assert(sizeof(AdExactWindowInfo) == AD_EXACT_WINDOW_INFO_SIZE, "AdExactWindowInfo ABI size changed");
_Static_assert(_Alignof(AdExactWindowInfo) == 8, "AdExactWindowInfo ABI alignment changed");
_Static_assert(offsetof(AdExactWindowInfo, version) == 0, "AdExactWindowInfo.version offset changed");
_Static_assert(offsetof(AdExactWindowInfo, size) == 4, "AdExactWindowInfo.size offset changed");
_Static_assert(offsetof(AdExactWindowInfo, window) == 8, "AdExactWindowInfo.window offset changed");
_Static_assert(offsetof(AdExactWindowInfo, process_instance) == 80, "AdExactWindowInfo.process_instance offset changed");
_Static_assert(offsetof(AdExactWindowInfo, accessible) == 88, "AdExactWindowInfo.accessible offset changed");
_Static_assert(sizeof(AdExactSurfaceInfo) == AD_EXACT_SURFACE_INFO_SIZE, "AdExactSurfaceInfo ABI size changed");
_Static_assert(_Alignof(AdExactSurfaceInfo) == 8, "AdExactSurfaceInfo ABI alignment changed");
_Static_assert(offsetof(AdExactSurfaceInfo, version) == 0, "AdExactSurfaceInfo.version offset changed");
_Static_assert(offsetof(AdExactSurfaceInfo, size) == 4, "AdExactSurfaceInfo.size offset changed");
_Static_assert(offsetof(AdExactSurfaceInfo, id) == 8, "AdExactSurfaceInfo.id offset changed");
_Static_assert(offsetof(AdExactSurfaceInfo, surface) == 16, "AdExactSurfaceInfo.surface offset changed");
_Static_assert(sizeof(AdDisplayInfo) == AD_DISPLAY_INFO_SIZE, "AdDisplayInfo ABI size changed");
_Static_assert(_Alignof(AdDisplayInfo) == 8, "AdDisplayInfo ABI alignment changed");
_Static_assert(offsetof(AdDisplayInfo, version) == 0, "AdDisplayInfo.version offset changed");
_Static_assert(offsetof(AdDisplayInfo, size) == 4, "AdDisplayInfo.size offset changed");
_Static_assert(offsetof(AdDisplayInfo, id) == 8, "AdDisplayInfo.id offset changed");
_Static_assert(offsetof(AdDisplayInfo, bounds) == 16, "AdDisplayInfo.bounds offset changed");
_Static_assert(offsetof(AdDisplayInfo, is_primary) == 48, "AdDisplayInfo.is_primary offset changed");
_Static_assert(offsetof(AdDisplayInfo, scale) == 56, "AdDisplayInfo.scale offset changed");
_Static_assert(sizeof(AdRefProcess) == AD_REF_PROCESS_SIZE, "AdRefProcess ABI size changed");
_Static_assert(sizeof(AdRefIdentity) == AD_REF_IDENTITY_SIZE, "AdRefIdentity ABI size changed");
_Static_assert(offsetof(AdRefIdentity, native_id) == 32, "AdRefIdentity.native_id offset changed");
_Static_assert(sizeof(AdStringSlice) == AD_STRING_SLICE_SIZE, "AdStringSlice ABI size changed");
_Static_assert(sizeof(AdRefCapabilities) == AD_REF_CAPABILITIES_SIZE, "AdRefCapabilities ABI size changed");
_Static_assert(sizeof(AdRefGeometry) == AD_REF_GEOMETRY_SIZE, "AdRefGeometry ABI size changed");
_Static_assert(offsetof(AdRefGeometry, bounds_hash) == 32, "AdRefGeometry.bounds_hash offset changed");
_Static_assert(offsetof(AdRefGeometry, bounds_space) == 44, "AdRefGeometry.bounds_space offset changed");
_Static_assert(sizeof(AdRefSource) == AD_REF_SOURCE_SIZE, "AdRefSource ABI size changed");
_Static_assert(offsetof(AdRefSource, window_bounds_hash) == 24, "AdRefSource.window_bounds_hash offset changed");
_Static_assert(sizeof(AdRefScope) == AD_REF_SCOPE_SIZE, "AdRefScope ABI size changed");
_Static_assert(offsetof(AdRefScope, path) == 8, "AdRefScope.path offset changed");
_Static_assert(sizeof(struct AdWaitArgs) == AD_WAIT_ARGS_SIZE, "AdWaitArgs ABI size drift");
_Static_assert(_Alignof(struct AdWaitArgs) == 8, "AdWaitArgs ABI alignment changed");
_Static_assert(offsetof(AdWaitArgs, mode) == 0, "AdWaitArgs.mode offset changed");
_Static_assert(offsetof(AdWaitArgs, predicate) == 48, "AdWaitArgs.predicate offset changed");
_Static_assert(offsetof(AdWaitArgs, scope) == 88, "AdWaitArgs.scope offset changed");
_Static_assert(sizeof(AdOptionalU64) == AD_OPTIONAL_U64_SIZE, "AdOptionalU64 ABI size changed");
_Static_assert(sizeof(AdOptionalUsize) == AD_OPTIONAL_USIZE_SIZE, "AdOptionalUsize ABI size changed");
_Static_assert(sizeof(AdWaitSurfaceModes) == AD_WAIT_SURFACE_MODES_SIZE, "AdWaitSurfaceModes ABI size changed");
_Static_assert(sizeof(AdWaitMode) == AD_WAIT_MODE_SIZE, "AdWaitMode ABI size changed");
_Static_assert(sizeof(AdWaitPredicate) == AD_WAIT_PREDICATE_SIZE, "AdWaitPredicate ABI size changed");
_Static_assert(sizeof(AdWaitScope) == AD_WAIT_SCOPE_SIZE, "AdWaitScope ABI size changed");
_Static_assert(sizeof(AdNode) == AD_NODE_SIZE, "AdNode ABI size changed");
_Static_assert(offsetof(AdNode, content) == 0, "AdNode.content offset changed");
_Static_assert(offsetof(AdNode, presentation) == 48, "AdNode.presentation offset changed");
_Static_assert(offsetof(AdNode, relation) == 96, "AdNode.relation offset changed");
_Static_assert(sizeof(AdNodeContent) == AD_NODE_CONTENT_SIZE, "AdNodeContent ABI size changed");
_Static_assert(sizeof(AdNodePresentation) == AD_NODE_PRESENTATION_SIZE, "AdNodePresentation ABI size changed");
_Static_assert(sizeof(AdNodeRelation) == AD_NODE_RELATION_SIZE, "AdNodeRelation ABI size changed");
_Static_assert(sizeof(AdNotificationIdentity) == AD_NOTIFICATION_IDENTITY_SIZE, "AdNotificationIdentity ABI size changed");
_Static_assert(sizeof(AdNotificationActionRequest) == AD_NOTIFICATION_ACTION_REQUEST_SIZE, "AdNotificationActionRequest ABI size changed");
_Static_assert(offsetof(AdNotificationActionRequest, identity) == 16, "AdNotificationActionRequest.identity offset changed");
_Static_assert(sizeof(AdFindQuery) == AD_FIND_QUERY_SIZE, "AdFindQuery ABI size changed");
_Static_assert(offsetof(AdFindQuery, filter) == 24, "AdFindQuery.filter offset changed");
_Static_assert(sizeof(AdFindControl) == AD_FIND_CONTROL_SIZE, "AdFindControl ABI size changed");
_Static_assert(offsetof(AdFindControl, timeout_ms) == 16, "AdFindControl.timeout_ms offset changed");
_Static_assert(sizeof(AdFindSelection) == AD_FIND_SELECTION_SIZE, "AdFindSelection ABI size changed");
_Static_assert(sizeof(AdFindIdentity) == AD_FIND_IDENTITY_SIZE, "AdFindIdentity ABI size changed");
_Static_assert(sizeof(AdFindStatePredicate) == AD_FIND_STATE_PREDICATE_SIZE, "AdFindStatePredicate ABI size changed");
_Static_assert(sizeof(AdFindStateSlice) == AD_FIND_STATE_SLICE_SIZE, "AdFindStateSlice ABI size changed");
_Static_assert(sizeof(AdFindFilter) == AD_FIND_FILTER_SIZE, "AdFindFilter ABI size changed");
_Static_assert(offsetof(AdFindFilter, exact) == 80, "AdFindFilter.exact offset changed");
#endif /* __STDC_VERSION__ >= 201112L */
#endif /* AGENT_DESKTOP_ABI_ASSERTS */
