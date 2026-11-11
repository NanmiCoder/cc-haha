(() => {
  const data = JSON.parse(document.getElementById('debug-data').textContent);
  const {groupNodes, imageSource, matchesRole, visibleRect} = DebugViewerFilter;
  const byId = id => document.getElementById(id);
  const ns = 'http://www.w3.org/2000/svg';
  const roles = new Set();
  let phase = data.before ? 'before' : 'after';
  let selected = data.mode === 'click' ? 0 : null;
  const explanations = {
    skeleton: 'Skeleton is a shallow overview (logical depth at most 3), not just the parent window. Amber dashed boxes are drill anchors; blue boxes have action refs; gray boxes provide context. children_count marks children not expanded here.',
    'drill-down': 'This tree starts at the requested root ref, inside its owning window. Only nodes returned by this drill-down are shown.',
    snapshot: 'These are the nodes returned by this snapshot, with its filters applied. Blue boxes have action refs; gray boxes provide context.',
    click: 'Before shows the strictly resolved target before command dispatch. After is a fresh screenshot of the same window. No post-click target box is drawn because the UI may have changed. This is not a live click recording.'
  };
  byId('explanation').textContent = explanations[data.mode];
  byId('notice').textContent = data.notice;
  byId('warning').textContent = [data.warning, data.error?.message].filter(Boolean).join('\n');
  byId('result').textContent = JSON.stringify(data.result || data.error || {snapshot_id: data.snapshot_id, ok: data.ok}, null, 2);
  byId('before').hidden = data.mode !== 'click';
  byId('after').hidden = data.mode !== 'click';
  byId('before').disabled = !data.before;
  byId('after').disabled = !data.after;
  byId('all').onclick = () => {
    roles.clear();
    selected = null;
    byId('highlights').checked = true;
    renderGroups();
    draw();
  };
  byId('highlights').onchange = draw;
  for (const name of ['before', 'after']) {
    byId(name).onclick = () => {
      phase = name;
      selected = data.mode === 'click' && name === 'before' ? 0 : null;
      render();
    };
  }
  function select(index) {
    selected = selected === index ? null : index;
    byId('nodes').querySelectorAll('.node').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.index) === selected));
    });
    draw();
  }
  function draw() {
    const frame = data[phase];
    const svg = byId('overlay');
    svg.replaceChildren();
    if (!frame || !byId('highlights').checked) return;
    const window = frame.window.bounds;
    svg.setAttribute('viewBox', `0 0 ${window.width} ${window.height}`);
    frame.nodes.forEach((node, index) => {
      if (node.not_visible || !matchesRole(node, roles) || (selected !== null && selected !== index)) return;
      const rect = visibleRect(node.bounds, window);
      if (!rect) return;
      const group = document.createElementNS(ns, 'g');
      group.setAttribute('class', node.kind);
      group.dataset.role = node.role;
      const box = document.createElementNS(ns, 'rect');
      for (const [name, value] of Object.entries(rect)) box.setAttribute(name, value);
      const label = document.createElementNS(ns, 'text');
      const alignRight = selected === index && rect.x > window.width / 2;
      label.setAttribute('text-anchor', alignRight ? 'end' : 'start');
      label.setAttribute('x', alignRight ? Math.min(window.width - 4, rect.x + rect.width) : Math.max(4, Math.min(rect.x + 4, window.width - 32)));
      label.setAttribute('y', Math.max(15, rect.y + 15));
      label.textContent = selected === index ? `${index + 1} ${node.ref_id || node.role}` : String(index + 1);
      group.append(box, label);
      svg.append(group);
    });
  }
  function nodeButton(node, index, frame) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'node';
    button.dataset.index = index;
    button.disabled = !matchesRole(node, roles);
    button.setAttribute('aria-pressed', String(selected === index));
    const title = document.createElement('strong');
    title.textContent = `${index + 1}. ${node.name || node.role}`;
    const ref = document.createElement('code');
    ref.textContent = node.ref_id || 'No ref · context only';
    const reason = document.createElement('small');
    reason.textContent = node.reason;
    if (node.children_count !== undefined) reason.textContent += ` ${node.children_count} unexpanded direct children.`;
    else if (node.subtree_truncated) reason.textContent += ' Descendants truncated; count unavailable.';
    if (node.not_visible) reason.textContent += ' Reported hidden or offscreen; highlight omitted.';
    else if (!visibleRect(node.bounds, frame.window.bounds)) reason.textContent += ' No drawable bounds inside this window.';
    button.append(title, ref, reason);
    button.onclick = () => select(index);
    return button;
  }
  function updateFilterCount() {
    const nodes = data[phase]?.nodes || [];
    const count = nodes.filter(node => matchesRole(node, roles)).length;
    byId('filter-status').textContent = roles.size ? `${count} of ${nodes.length} nodes in selected roles` : `All ${nodes.length} nodes · no role filter`;
  }
  function renderGroups() {
    const frame = data[phase];
    byId('nodes').replaceChildren();
    updateFilterCount();
    if (!frame) return;
    for (const group of groupNodes(frame.nodes)) {
      const section = document.createElement('section');
      section.className = 'role-group';
      section.dataset.role = group.role;
      const header = document.createElement('div');
      header.className = 'role-header';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = roles.has(group.role);
      checkbox.setAttribute('aria-label', `Show only ${group.label.toLowerCase()}`);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'role-toggle';
      toggle.textContent = `${group.label} (${group.items.length})`;
      const list = document.createElement('div');
      list.className = 'role-items';
      list.id = `role-items-${group.role}`;
      const expand = open => { list.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); };
      expand(data.mode === 'click');
      toggle.setAttribute('aria-controls', list.id);
      toggle.onclick = () => expand(list.hidden);
      for (const {node, index} of group.items) list.append(nodeButton(node, index, frame));
      checkbox.onchange = () => {
        if (checkbox.checked) roles.add(group.role); else roles.delete(group.role);
        selected = null;
        byId('highlights').checked = true;
        for (const other of byId('nodes').querySelectorAll('.role-group')) {
          if (roles.size && !roles.has(other.dataset.role)) {
            other.querySelector('.role-items').hidden = true;
            other.querySelector('.role-toggle').setAttribute('aria-expanded', 'false');
          }
        }
        byId('nodes').querySelectorAll('.node').forEach(button => {
          button.setAttribute('aria-pressed', 'false');
          button.disabled = !matchesRole(frame.nodes[Number(button.dataset.index)], roles);
        });
        updateFilterCount();
        draw();
      };
      header.append(checkbox, toggle);
      section.append(header, list);
      byId('nodes').append(section);
    }
  }
  function render() {
    const frame = data[phase];
    byId('stage').hidden = !frame;
    for (const name of ['before', 'after']) byId(name).setAttribute('aria-pressed', String(name === phase));
    byId('phase').textContent = frame ? (phase === 'before' ? 'Before dispatch: requested target' : data.mode === 'click' ? 'After command: observed window' : 'Returned tree over captured window') : 'Screenshot unavailable';
    if (frame) {
      byId('summary').textContent = `${data.mode} · ${frame.window.app} · ${frame.window.title || frame.window.id} · ${data.ok ? 'command succeeded' : 'command failed'}`;
      byId('capture').src = imageSource(frame.image);
      byId('capture').alt = `${frame.window.app} window, ${phase} command capture`;
      byId('list-title').textContent = `${frame.nodes.length} ${data.mode === 'click' ? 'target elements' : 'returned nodes'}`;
    }
    renderGroups();
    draw();
  }
  render();
})();
