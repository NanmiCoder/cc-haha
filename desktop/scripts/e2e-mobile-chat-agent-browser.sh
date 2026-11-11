#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BROWSER_BIN="${AGENT_BROWSER_BIN:-agent-browser}"
NODE_BIN="${CC_HAHA_NODE_BIN:-node}"
ARTIFACT_DIR="${CC_HAHA_SMOKE_ARTIFACT_DIR:-$(mktemp -d /tmp/cc-haha-mobile-chat-XXXXXX)}"
mkdir -p "$ARTIFACT_DIR"
BROWSER_CONFIG="$ARTIFACT_DIR/browser-config.json"
printf '{}\n' >"$BROWSER_CONFIG"
PORT="$(bun -e 'const s=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});console.log(s.port);s.stop(true)')"
SESSION_NAME="cc-haha-mobile-chat-$$-$RANDOM"
ab() { "$BROWSER_BIN" --config "$BROWSER_CONFIG" --allowed-domains 127.0.0.1 --session "$SESSION_NAME" "$@"; }
cleanup() {
  local code=$?
  if [[ "$code" != 0 ]]; then
    ab snapshot -i >"$ARTIFACT_DIR/failure.txt" 2>&1 || true
    ab eval 'window.mobileChatSmoke' >"$ARTIFACT_DIR/failure-evidence.json" 2>&1 || true
    ab screenshot "$ARTIFACT_DIR/failure.png" >/dev/null 2>&1 || true
  fi
  ab close >/dev/null 2>&1 || true
  if [[ -n "${WEB_PID:-}" ]]; then kill "$WEB_PID" >/dev/null 2>&1 || true; wait "$WEB_PID" >/dev/null 2>&1 || true; fi
  echo "Mobile chat smoke artifacts: $ARTIFACT_DIR"
  exit "$code"
}
trap cleanup EXIT
(cd "$ROOT_DIR/desktop" && exec "$NODE_BIN" node_modules/vite/bin/vite.js --config scripts/fixtures/mobile-chat/vite.config.ts --host 127.0.0.1 --port "$PORT") >"$ARTIFACT_DIR/vite.log" 2>&1 &
WEB_PID=$!
URL="http://127.0.0.1:$PORT/scripts/fixtures/mobile-chat/index.html"
for _ in $(seq 1 60); do
  if curl --silent --fail "$URL" >/dev/null; then break; fi
  sleep 0.2
done
assert_layout() {
  ab eval '(() => { const root = document.querySelector("[data-testid=mobile-shell]"); if (!root) throw new Error("Mobile shell missing"); if (document.documentElement.scrollWidth > innerWidth || root.getBoundingClientRect().right > innerWidth + 1) throw new Error("Horizontal page overflow"); for (const control of document.querySelectorAll("[data-testid=empty-session-toolbar] button, [data-testid=chat-input-toolbar] button")) { if (control.closest("[inert], [hidden]")) continue; const r = control.getBoundingClientRect(); if (r.width && (r.left < -1 || r.right > innerWidth + 1)) throw new Error("Composer control clipped: " + control.getAttribute("aria-label")); } const bad = window.mobileChatSmoke.unexpected; if (bad.length) throw new Error(JSON.stringify(bad)); return "layout and hermetic requests: PASS" })()'
}
assert_picker_frontmost() {
  ab eval '(() => { const picker = document.querySelector("[data-testid=model-selector-dropdown]"); if (!picker) throw new Error("Model picker missing"); const r = picker.getBoundingClientRect(); if (r.left < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) throw new Error("Model picker outside viewport"); const target = picker.querySelector("input") || picker; const t = target.getBoundingClientRect(); const hit = document.elementFromPoint(t.left + t.width / 2, t.top + Math.min(t.height / 2, 20)); if (!picker.contains(hit)) throw new Error("Model picker does not receive touches"); return "model picker receives touches: PASS" })()'
}
wait_settled() {
  ab wait --fn 'document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity)'
}
assert_draft_page() {
  ab wait '[data-testid="new-session-draft-panel"]:not([hidden])'
  wait_settled
  ab eval '(() => { const p = document.querySelector("[data-testid=new-session-draft-panel]:not([hidden])"); const r = p.getBoundingClientRect(); if (p.closest("[role=dialog]") || document.querySelector("[data-testid=mobile-new-task-sheet]")) throw new Error("New chat is still a modal sheet"); if (r.top > 80 || r.bottom < innerHeight - 2) throw new Error("New chat does not fill main page"); if (!p.textContent.includes("DeepSeek") || p.textContent.includes("配置模型")) throw new Error("Configured model is not immediately available"); return "full-page draft with configured model: PASS" })()'
}
open_drawer() {
  ab click '[data-testid="mobile-open-sessions"]'
  ab wait '[data-testid="mobile-session-drawer-panel"]'
  wait_settled
}
wait_drawer_closed() { ab wait --fn '!document.querySelector("[data-testid=mobile-session-drawer]")'; }
native_back() {
  ab eval '(() => { if (window.__CC_HAHA_MOBILE_NAVIGATE_BACK__?.() !== true) throw new Error("Native Back not handled"); return "native Back handled" })()'
}
assert_navigation_keeps_connection() {
  ab eval '(() => { const e = window.mobileChatSmoke; if (e.connects.length !== e.connectionCheckpoint || e.disconnects.length) throw new Error("Navigation reconnects session: " + JSON.stringify(e)); return "navigation keeps session connection: PASS" })()'
}
# Re-run only the short viewport probes without repeating the full matrix.
if [[ "${CC_HAHA_MOBILE_SMOKE_COMPACT_ONLY:-0}" != 1 ]]; then
for THEME in white dark paper; do
  for WIDTH in 390 360; do
    LABEL="$THEME-$WIDTH"
    SESSION_NAME="cc-haha-mobile-chat-$$-$THEME-$WIDTH"
    ab open "$URL?theme=$THEME"
    ab set viewport "$WIDTH" 844
    ab wait '[data-testid="mobile-open-sessions"]'
    assert_draft_page
    assert_layout
    ab eval '(() => { const e = window.mobileChatSmoke; if (e.connects.length || e.requests.some(r => r.includes("auth-status"))) throw new Error("Draft eagerly connects or rechecks account credentials"); return "draft needs no chat connection or auth probes: PASS" })()'
    ab screenshot "$ARTIFACT_DIR/$LABEL-home.png"
    ab click '[data-testid="new-session-draft-panel"] [data-testid="model-selector-shell"] button[aria-haspopup="dialog"]'
    ab wait '[data-testid="model-selector-dropdown"]'
    assert_layout
    assert_picker_frontmost
    ab snapshot -i >"$ARTIFACT_DIR/$LABEL-picker.txt"
    ab screenshot "$ARTIFACT_DIR/$LABEL-picker.png"
    ab find role button click --name 'DeepSeek-V4-Pro'
    ab wait --fn '!document.querySelector("[data-testid=model-selector-dropdown]")'
    ab find role textbox fill '验证手机首轮使用所选 DeepSeek 模型'
    ab find role button click --name '运行' --exact
    ab wait --fn 'window.mobileChatSmoke.sends.length === 1'
    ab eval '(() => { const e = window.mobileChatSmoke; const s = e.sends[0]; if (e.creates.length !== 1 || e.creates[0].workDir !== "/fixture/mobile-project" || s.runtimeSelection?.providerId !== "deepseek-account" || s.runtimeSelection?.modelId !== "deepseek-v4-pro") throw new Error(JSON.stringify(e)); if (e.requests.some(r => r.includes("/api/haha-"))) throw new Error("Public picker requested forbidden OAuth route"); return "first turn DeepSeek provider/model: PASS" })()'
    ab wait --fn 'window.mobileChatSmoke.state.activeTabId === "fixture-created"'
    wait_settled
    assert_layout
    ab screenshot "$ARTIFACT_DIR/$LABEL-chat.png"
    ab find role textbox fill '保留这段会话草稿'
    ab eval 'window.mobileChatSmoke.connectionCheckpoint = window.mobileChatSmoke.connects.length'

    open_drawer
    ab eval '(() => { const p = document.querySelector("[data-testid=mobile-session-drawer-panel]").getBoundingClientRect(); if (p.width >= innerWidth - 20 || p.width < innerWidth * .7 || p.left !== 0) throw new Error("Drawer must cover only part of the phone"); if (window.mobileChatSmoke.state.activeTabId !== "fixture-created" || !document.querySelector("#content-area[inert]")) throw new Error("Drawer replaced active chat"); return "partial-width drawer retains chat: PASS" })()'
    assert_navigation_keeps_connection
    ab screenshot "$ARTIFACT_DIR/$LABEL-drawer.png"
    native_back
    wait_drawer_closed
    ab eval '(() => { if (window.mobileChatSmoke.state.activeTabId !== "fixture-created" || window.__CC_HAHA_MOBILE_NAVIGATE_BACK__?.() !== false) throw new Error("Back left chat root"); return "Back closes drawer and stays in chat: PASS" })()'

    open_drawer
    # Browser mouse input emits real trusted pointer events through the same
    # drawer recognizer as a horizontal touch; no DOM dispatch or handler call.
    ab mouse move 280 500
    ab mouse down
    ab mouse move 230 500
    ab mouse move 120 500
    ab mouse move 40 500
    ab mouse up
    wait_drawer_closed
    assert_navigation_keeps_connection

    open_drawer
    ab mouse move "$((WIDTH - 10))" 420
    ab mouse down
    ab mouse up
    wait_drawer_closed
    assert_navigation_keeps_connection
    ab eval '(() => { const input = Array.from(document.querySelectorAll("[data-testid=session-tab-panel] [role=textbox], [data-testid=session-tab-panel] textarea")).find(el => el.getBoundingClientRect().width > 0 && !el.closest("[inert], [hidden]")); if (!String(input?.isContentEditable ? input.textContent : input?.value).includes("保留这段会话草稿")) throw new Error("Drawer lost chat draft"); return "drawer gestures preserve composer: PASS" })()'

    open_drawer
    ab find text '继续完善手机交互' click
    wait_drawer_closed
    ab wait --text '让手机上新建聊天和选择模型更顺手。'
    ab find role textbox fill '保留既有会话的输入'
    ab eval '(() => { const e = window.mobileChatSmoke; e.connectionCheckpoint = e.connects.length; e.authCheckpoint = e.requests.filter(r => r.includes("auth-status")).length; })()'
    ab find role button click --name '新任务' --exact
    assert_draft_page
    assert_navigation_keeps_connection
    ab find role textbox fill '保留这段新任务草稿'
    ab click '[data-testid="new-session-draft-panel"] [data-testid="model-selector-shell"] button[aria-haspopup="dialog"]'
    ab wait '[data-testid="model-selector-dropdown"]'
    assert_picker_frontmost
    native_back
    ab wait --fn '!document.querySelector("[data-testid=model-selector-dropdown]")'
    assert_draft_page
    native_back
    ab wait --fn 'window.mobileChatSmoke.state.activeTabId === "fixture-existing"'
    assert_navigation_keeps_connection
    ab eval '(() => { const input = Array.from(document.querySelectorAll("[data-testid=session-tab-panel] [role=textbox], [data-testid=session-tab-panel] textarea")).find(el => el.getBoundingClientRect().width > 0 && !el.closest("[inert], [hidden]")); if (!String(input?.isContentEditable ? input.textContent : input?.value).includes("保留既有会话的输入")) throw new Error("Returning from new chat lost session draft"); return "Back retains existing session draft: PASS" })()'
    ab find role button click --name '新任务' --exact
    assert_draft_page
    ab eval '(() => { const e = window.mobileChatSmoke; const input = Array.from(document.querySelectorAll("[data-testid=new-session-draft-panel] [role=textbox], [data-testid=new-session-draft-panel] textarea")).find(el => el.getBoundingClientRect().width > 0 && !el.closest("[inert], [hidden]")); if (!String(input?.isContentEditable ? input.textContent : input?.value).includes("保留这段新任务草稿")) throw new Error("Reopening new chat lost draft"); if (e.requests.filter(r => r.includes("auth-status")).length !== e.authCheckpoint || e.creates.length !== 1) throw new Error("Reopening draft rechecked accounts or created a session"); return "draft and cached model survive switching: PASS" })()'
    assert_navigation_keeps_connection
    assert_layout
    ab screenshot "$ARTIFACT_DIR/$LABEL-draft-retained.png"
    ab find role button click --name '返回' --exact
    ab wait --fn 'window.mobileChatSmoke.state.activeTabId === "fixture-existing"'
    # Exercise actual browser history as well as the native Back bridge. The
    # drawer and returnable draft share a guarded depth, which must re-arm.
    ab find role button click --name '新任务' --exact
    assert_draft_page
    open_drawer
    ab back
    wait_drawer_closed
    assert_draft_page
    ab back
    ab wait --fn 'window.mobileChatSmoke.state.activeTabId === "fixture-existing"'
    assert_navigation_keeps_connection
    ab eval '(() => { if (window.__CC_HAHA_MOBILE_NAVIGATE_BACK__?.() !== false) throw new Error("Browser Back did not reach chat root"); return "browser Back closes nested drawer then returns to chat: PASS" })()'
    assert_layout
    ab screenshot "$ARTIFACT_DIR/$LABEL-existing.png"
    ab eval 'window.mobileChatSmoke' >"$ARTIFACT_DIR/$LABEL-evidence.json"
    ab close
  done
done
printf 'PASS: 390px/360px, white/dark/paper; full-page new chat, cached DeepSeek first turn, partial drawer click/swipe/native and browser Back, retained drafts, no navigation reconnect or overflow/external application requests\n'
fi

# This is a resized browser viewport with focus retained, not evidence of an
# Android/iOS keyboard or visualViewport/IME integration on a physical phone.
for WIDTH in 390 360; do
  LABEL="white-$WIDTH-compact-460"
  SESSION_NAME="cc-haha-mobile-chat-$$-compact-$WIDTH"
  ab open "$URL?theme=white"
  ab set viewport "$WIDTH" 844
  assert_draft_page
  ab find role textbox fill '小屏可视区域输入验证'
  ab focus '[data-testid="new-session-draft-panel"] [data-composer-editor="true"]'
  ab set viewport "$WIDTH" 460
  wait_settled
  assert_draft_page
  assert_layout
  ab eval '(() => { const draft = document.querySelector("[data-testid=new-session-draft-panel]:not([hidden])"); const header = document.querySelector("[data-testid=mobile-top-bar]"); const editor = draft.querySelector("[data-composer-editor=true]"); const model = draft.querySelector("[data-testid=model-selector-shell] button[aria-haspopup=dialog]"); const send = draft.querySelector("button[aria-label=运行]"); const h = header.getBoundingClientRect(); if (h.top < -1 || h.bottom > 80) throw new Error("Header moved or covered the composer"); if (document.activeElement !== editor) throw new Error("Viewport resize lost editor focus"); const rects = {}; for (const [name, element] of Object.entries({ editor, model, send })) { if (!element) throw new Error(name + " missing"); const r = element.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0 || r.left < 0 || r.right > innerWidth + 1 || r.top < h.bottom || r.bottom > innerHeight + 1) throw new Error(name + " is clipped or behind header"); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!element.contains(hit)) throw new Error(name + " is covered"); rects[name] = r.toJSON(); } if (send.disabled) throw new Error("Send disabled despite text"); window.mobileChatSmoke.compactViewport = { simulation: "resized desktop browser viewport with focused editor; not a physical soft keyboard", viewport: { width: innerWidth, height: innerHeight }, editorFocused: true, header: h.toJSON(), controls: rects }; return "focused short viewport controls visible and unobstructed: PASS" })()'
  ab screenshot "$ARTIFACT_DIR/$LABEL-focused.png"
  ab eval 'window.mobileChatSmoke' >"$ARTIFACT_DIR/$LABEL-evidence.json"
  ab close
done
printf 'PASS: focused full-page composer at 390x460 and 360x460; input/model/send visible, no header overlap or horizontal overflow (viewport simulation only)\n'
