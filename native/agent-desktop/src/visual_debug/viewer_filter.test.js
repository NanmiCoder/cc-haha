const {test} = require('node:test');
const assert = require('node:assert/strict');
const {groupNodes, imageSource, matchesRole, visibleRect} = require('./viewer_filter.js');

const nodes = [{role: 'window'}, {role: 'treeitem'}, {role: 'button'}, {role: 'treeitem'}];

test('role groups retain original indices and refs instead of renumbering targets', () => {
  const groups = groupNodes(nodes);
  assert.deepEqual(groups.map(g => g.role), ['window', 'treeitem', 'button']);
  assert.deepEqual(groups[1].items.map(item => item.index), [1, 3]);
  assert.equal(groups[1].label, 'Tree items');
  assert.equal(groups[1].items[0].node, nodes[1]);
});

test('no role selection shows all; one selection isolates; multiple form a union', () => {
  const roles = new Set();
  const filtered = () => nodes.filter(node => matchesRole(node, roles)).map(node => node.role);
  assert.equal(filtered().length, 4);
  roles.add('treeitem');
  assert.deepEqual(filtered(), ['treeitem', 'treeitem']);
  roles.add('button');
  assert.deepEqual(filtered(), ['treeitem', 'button', 'treeitem']);
  roles.clear();
  assert.equal(filtered().length, 4);
  assert.deepEqual(groupNodes([]), []);
});

test('geometry clips to the window and handles negative monitor origins', () => {
  const window = {x: -1000, y: 50, width: 600, height: 400};
  assert.deepEqual(visibleRect({x: -1010, y: 60, width: 30, height: 20}, window), {x: 0, y: 10, width: 20, height: 20});
  assert.equal(visibleRect({x: 0, y: 60, width: 30, height: 20}, window), null);
  assert.equal(visibleRect(null, window), null);
  assert.equal(visibleRect({x: NaN, y: 60, width: 30, height: 20}, window), null);
});

test('only a base64 PNG data URI is accepted as an image source', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(imageSource(png), png);
  for (const rejected of [
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=',
    ' data:image/png;base64,iVBORw0KGgo=',
    'data:image/png;base64,iVBORw0KGgo=<script>',
    undefined,
  ]) {
    assert.equal(imageSource(rejected), '');
  }
});
