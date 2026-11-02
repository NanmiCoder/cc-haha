(function () {
  "use strict";

  var BASE64_RE = /^[A-Za-z0-9+/=]+$/;
  var DATA_PREFIX = "data:image/png;base64,";
  var rows = [];
  var selectedIndex = -1;
  var payload;

  function parsePayload() {
    var node = document.getElementById("trace-data");
    try {
      return JSON.parse(node.textContent || "{}");
    } catch (e) {
      return { events: [], warnings: [{ kind: "parse_error", message: String(e) }] };
    }
  }

  function redactValue(value, indent) {
    indent = indent || 0;
    var pad = "  ".repeat(indent);
    if (value && typeof value === "object" && value.redacted === true) return "⟨redacted⟩";
    if (Array.isArray(value)) {
      if (!value.length) return "[]";
      return "[\n" + value.map(function (item) {
        return "  ".repeat(indent + 1) + redactValue(item, indent + 1);
      }).join(",\n") + "\n" + pad + "]";
    }
    if (value && typeof value === "object") {
      var keys = Object.keys(value);
      if (!keys.length) return "{}";
      return "{\n" + keys.map(function (key) {
        return "  ".repeat(indent + 1) + JSON.stringify(key) + ": " + redactValue(value[key], indent + 1);
      }).join(",\n") + "\n" + pad + "}";
    }
    return JSON.stringify(value);
  }

  function groupEvents(events) {
    var groups = [];
    var stack = [];
    events.forEach(function (event, index) {
      var name = event.event || "";
      if (name === "command.start") {
        var frame = { command: event.command || "command", start: event, children: [], end: null, open: true };
        groups.push({ type: "group", group: frame });
        stack.push(frame);
        return;
      }
      if (name === "command.end") {
        if (stack.length) {
          var top = stack.pop();
          top.end = event;
          top.open = false;
        } else {
          groups.push({ type: "event", event: event, index: index });
        }
        return;
      }
      if (stack.length) stack[stack.length - 1].children.push({ event: event, index: index });
      else groups.push({ type: "event", event: event, index: index });
    });
    return groups;
  }

  function statusOf(group) {
    if (group.open || !group.end) return { cls: "open-incomplete", label: "incomplete", glyph: "○" };
    return group.end.ok
      ? { cls: "ok", label: "ok", glyph: "✓" }
      : { cls: "err", label: "error", glyph: "✗" };
  }

  function safeDataUri(uri) {
    if (typeof uri !== "string" || uri.indexOf(DATA_PREFIX) !== 0) return null;
    var payloadStr = uri.slice(DATA_PREFIX.length);
    return payloadStr && BASE64_RE.test(payloadStr) ? uri : null;
  }

  function rowSummary(e) {
    var n = e.event || "";
    if (n === "snapshot.saved" || n === "snapshot.root.saved") {
      return [e.snapshot_id, e.ref_count != null ? e.ref_count + " refs" : null, e.app].filter(Boolean).join(" · ");
    }
    if (n === "action.artifacts") return "before / after";
    if (n === "action.dispatch.ok") return e.action || "";
    if (n === "command.end") return (e.ok ? "ok" : "error") + (e.code ? " · " + e.code : "");
    if (e.ref) return String(e.ref) + (e.action ? " · " + e.action : "");
    if (e.code) return String(e.code);
    if (typeof e.message === "string") return e.message;
    return "";
  }

  function eventNameNode(name) {
    var el = document.createElement("div");
    el.className = "event-name";
    var text = name || "(unknown)";
    var dot = text.indexOf(".");
    if (dot > 0) {
      var head = document.createElement("span");
      head.className = "seg-a";
      head.textContent = text.slice(0, dot);
      el.appendChild(head);
      el.appendChild(document.createTextNode(text.slice(dot)));
    } else {
      el.textContent = text;
    }
    return el;
  }

  function makeRow(event, depth, onSelect) {
    var row = document.createElement("div");
    row.className = "event-row";
    row.style.animationDelay = Math.min(rows.length * 7, 300) + "ms";
    if (depth) row.classList.add("child");
    row.appendChild(eventNameNode(event.event));
    var sum = rowSummary(event);
    if (sum) {
      var s = document.createElement("span");
      s.className = "event-summary";
      s.textContent = sum;
      row.appendChild(s);
    }
    var meta = document.createElement("span");
    meta.className = "event-meta";
    meta.textContent = event.ts_ms != null ? String(event.ts_ms) : "—";
    row.appendChild(meta);
    register(row, onSelect);
    return row;
  }

  function register(el, onSelect) {
    var i = rows.length;
    el.addEventListener("click", function () { select(i); });
    rows.push({ el: el, run: onSelect });
  }

  function renderTimeline(container, p, filterText) {
    container.textContent = "";
    rows = [];
    selectedIndex = -1;
    var events = p.events || [];
    var ft = filterText ? filterText.toLowerCase() : "";
    var filtered = events.filter(function (e) {
      return !ft || String(e.event || "").toLowerCase().indexOf(ft) !== -1;
    });
    setMatchCount(filtered.length, events.length, !!ft);
    if (!filtered.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      var mark = document.createElement("span");
      mark.className = "em-mark";
      mark.textContent = ft ? "∅" : "—";
      empty.appendChild(mark);
      empty.appendChild(document.createTextNode(ft ? "No events match the filter." : "No events in this trace."));
      container.appendChild(empty);
      return;
    }
    groupEvents(filtered).forEach(function (item) {
      if (item.type === "event") {
        container.appendChild(makeRow(item.event, false, detailFor(item.event)));
        return;
      }
      var group = item.group;
      var st = statusOf(group);
      var wrap = document.createElement("div");
      wrap.className = "group";
      var header = document.createElement("div");
      header.className = "group-header " + st.cls;
      var cmd = document.createElement("span");
      cmd.className = "group-cmd";
      cmd.textContent = group.command;
      header.appendChild(cmd);
      if (group.end && group.end.duration_ms != null) {
        var dur = document.createElement("span");
        dur.className = "dur";
        dur.textContent = group.end.duration_ms + "ms";
        header.appendChild(dur);
      }
      var badge = document.createElement("span");
      badge.className = "status " + st.cls;
      badge.textContent = st.glyph + " " + st.label;
      header.appendChild(badge);
      register(header, commandDetail(group));
      wrap.appendChild(header);
      group.children.forEach(function (child) {
        wrap.appendChild(makeRow(child.event, true, detailFor(child.event)));
      });
      container.appendChild(wrap);
    });
  }

  function select(i) {
    if (i < 0 || i >= rows.length) return;
    if (selectedIndex >= 0 && rows[selectedIndex]) rows[selectedIndex].el.classList.remove("selected");
    selectedIndex = i;
    rows[i].el.classList.add("selected");
    rows[i].el.scrollIntoView({ block: "nearest" });
    rows[i].run();
  }

  function step(delta) {
    if (!rows.length) return;
    var next = selectedIndex < 0 ? 0 : selectedIndex + delta;
    select(Math.max(0, Math.min(rows.length - 1, next)));
  }

  function detailFor(event) {
    return function () {
      setDetail(event.event || "Detail", redactValue(event, 0), artifactsIn([event]));
    };
  }

  function commandDetail(group) {
    return function () {
      var st = statusOf(group);
      var summary = { command: group.command, status: st.label };
      if (group.end) {
        if (group.end.duration_ms != null) summary.duration_ms = group.end.duration_ms;
        if (group.end.ok != null) summary.ok = group.end.ok;
        if (group.end.code) summary.code = group.end.code;
        if (group.end.message != null) summary.message = group.end.message;
      }
      var steps = group.children.map(function (c) { return c.event.event; }).filter(Boolean);
      if (steps.length) summary.steps = steps;
      setDetail(group.command + "  " + st.glyph + " " + st.label, redactValue(summary, 0),
        artifactsIn(group.children.map(function (c) { return c.event; })));
    };
  }

  function artifactsIn(events) {
    return events.filter(function (e) { return e && e.event === "action.artifacts"; });
  }

  function setDetail(title, body, artifacts) {
    document.getElementById("detail-title").textContent = title;
    document.getElementById("detail-body").textContent = body;
    var shotsEl = document.getElementById("shots");
    shotsEl.textContent = "";
    artifacts.forEach(function (ev) {
      ["screenshot_pre", "screenshot_post"].forEach(function (key) {
        var wrap = document.createElement("div");
        wrap.className = "shot-wrap";
        var caption = document.createElement("div");
        caption.className = "shot-label";
        caption.textContent = key === "screenshot_pre" ? "before" : "after";
        wrap.appendChild(caption);
        var rel = ev[key];
        var uri = rel && payload.screenshots ? safeDataUri(payload.screenshots[rel]) : null;
        if (uri) {
          var img = document.createElement("img");
          img.alt = caption.textContent + " screenshot";
          img.src = uri;
          img.addEventListener("click", function () { openLightbox(uri); });
          wrap.appendChild(img);
        } else {
          var miss = document.createElement("div");
          miss.className = "thumb-missing";
          miss.textContent = "screenshot unavailable";
          wrap.appendChild(miss);
        }
        shotsEl.appendChild(wrap);
      });
    });
  }

  function openLightbox(uri) {
    document.getElementById("lightbox-img").src = uri;
    document.getElementById("lightbox").classList.remove("hidden");
  }

  function closeLightbox() {
    document.getElementById("lightbox").classList.add("hidden");
    document.getElementById("lightbox-img").src = "";
  }

  function setMatchCount(shown, total, filtering) {
    document.getElementById("match-count").textContent = filtering ? shown + " / " + total : "";
  }

  function pill(label, value) {
    var el = document.createElement("span");
    el.className = "pill";
    var k = document.createElement("span");
    k.className = "k";
    k.textContent = label;
    var v = document.createElement("b");
    v.textContent = value;
    el.appendChild(k);
    el.appendChild(v);
    return el;
  }

  function renderMeta(p) {
    var meta = document.getElementById("meta");
    meta.textContent = "";
    meta.appendChild(pill("session", p.session_id || "?"));
    meta.appendChild(pill("events", (p.returned_events || 0) + " / " + (p.total_events || 0)));
    if (p.screenshots_embedded) meta.appendChild(pill("shots", String(p.screenshots_embedded)));
    if (p.truncated) meta.appendChild(pill("view", "tail"));
  }

  function renderWarnings(p) {
    var node = document.getElementById("warnings");
    var lines = [];
    (p.warnings || []).forEach(function (w) {
      lines.push(String(w.kind || "warning") + ": " + String(w.message || ""));
    });
    if (p.truncated) lines.push("Timeline truncated to the last " + (p.returned_events || 0) + " events.");
    if (p.screenshots_skipped) {
      lines.push("Embedded " + (p.screenshots_embedded || 0) + " screenshots; " + p.screenshots_skipped + " omitted (budget or missing).");
    }
    if (!lines.length) { node.className = "banner hidden"; node.textContent = ""; return; }
    node.className = "banner";
    node.textContent = lines.join("\n");
  }

  function syncHeaderHeight() {
    var h = document.querySelector("header").offsetHeight + 3;
    document.documentElement.style.setProperty("--header-h", h + "px");
  }

  payload = parsePayload();
  var timeline = document.getElementById("timeline");
  var filter = document.getElementById("filter");

  renderMeta(payload);
  renderWarnings(payload);
  syncHeaderHeight();
  window.addEventListener("resize", syncHeaderHeight);

  function rerender() {
    renderTimeline(timeline, payload, filter.value.trim());
    if (rows.length) select(0);
  }

  filter.addEventListener("input", rerender);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeLightbox(); return; }
    if (document.activeElement === filter) return;
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); step(-1); }
    else if (e.key === "/") { e.preventDefault(); filter.focus(); }
  });
  document.getElementById("lightbox").addEventListener("click", closeLightbox);

  rerender();
})();
