const DebugViewerFilter = (() => {
  const labels = {
    window: 'Windows', group: 'Containers', treeitem: 'Tree items', button: 'Buttons',
    scrollarea: 'Scroll areas', scrollbar: 'Scrollbars', textfield: 'Text fields',
    statictext: 'Static text', checkbox: 'Checkboxes', combobox: 'Combo boxes',
    menubutton: 'Menu buttons', outline: 'Outlines', list: 'Lists', browser: 'Browsers',
    colorwell: 'Color controls', ruler: 'Rulers', handle: 'Handles'
  };
  function groupNodes(nodes) {
    const groups = new Map();
    nodes.forEach((node, index) => {
      if (!groups.has(node.role)) groups.set(node.role, {
        role: node.role, label: Object.hasOwn(labels, node.role) ? labels[node.role] : node.role, items: []
      });
      groups.get(node.role).items.push({node, index});
    });
    return [...groups.values()];
  }
  function matchesRole(node, roles) { return roles.size === 0 || roles.has(node.role); }
  function imageSource(value) {
    return typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : '';
  }
  function visibleRect(bounds, window) {
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
    const x = Math.max(0, bounds.x - window.x);
    const y = Math.max(0, bounds.y - window.y);
    const right = Math.min(window.width, bounds.x + bounds.width - window.x);
    const bottom = Math.min(window.height, bounds.y + bounds.height - window.y);
    return right > x && bottom > y ? {x, y, width: right - x, height: bottom - y} : null;
  }
  return {groupNodes, imageSource, matchesRole, visibleRect};
})();
if (typeof module !== 'undefined') module.exports = DebugViewerFilter;
