#!/usr/bin/env python3
"""Run in a private desktop session against the candidate CLI, twice per tier."""

import argparse
import json
import os
from pathlib import Path
import selectors
import socket
import subprocess
import tempfile
import threading
import time


FIXTURE = """
import gi, os
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib
Gtk.init()
w = Gtk.Window(title='ad-display-matrix')
w.set_default_size(320, 120)
e = Gtk.Entry()
e.set_placeholder_text('matrix-entry')
w.set_child(e)
e.connect('changed', lambda e: open(os.environ['AD_MATRIX_TEXT'], 'w').write(e.get_text()))
w.present()
GLib.MainLoop().run()
"""

PORTAL = """
import gi, json, os, signal, sys
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
def call(method, parameters):
    return bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                         'org.freedesktop.DBus', method, parameters, None,
                         Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
name = 'org.freedesktop.portal.Desktop'
try:
    pid = call('GetConnectionUnixProcessID', GLib.Variant('(s)', (name,)))
except GLib.Error:
    pid = None
if pid is not None:
    expected = ('AGENT_DESKTOP_PRIVATE_SESSION=' + os.environ['AGENT_DESKTOP_PRIVATE_SESSION']).encode()
    assert expected in open('/proc/%s/environ' % pid, 'rb').read().split(bytes([0]))
    os.kill(pid, signal.SIGTERM)
xml = '''<node><interface name="org.freedesktop.portal.Screenshot">
<method name="Screenshot"><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/>
<arg type="o" direction="out"/></method></interface></node>'''
def refuse(connection, sender, path, interface, method, parameters, invocation):
    with open(sys.argv[1], 'a') as log:
        log.write(method + '\\n')
    invocation.return_dbus_error('org.freedesktop.portal.Error.Failed', 'matrix route oracle')
bus.register_object('/org/freedesktop/portal/desktop',
                    Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], refuse, None, None)
def acquired(*args):
    mutter = call('NameHasOwner', GLib.Variant('(s)', ('org.gnome.Mutter.DisplayConfig',)))
    print(json.dumps({'mutter': mutter}), flush=True)
Gio.bus_own_name_on_connection(bus, name, Gio.BusNameOwnerFlags.NONE, acquired, None)
GLib.MainLoop().run()
"""


class Silent:
    def __init__(self, address=None):
        self.listener = socket.socket(socket.AF_UNIX if address else socket.AF_INET)
        self.listener.bind(address or ('127.0.0.1', 0))
        self.listener.listen(128)
        self.listener.settimeout(0.1)
        self.address = address
        if address is None:
            self.address = f'127.0.0.1:{self.listener.getsockname()[1] - 6000}'
        self.accepted = 0
        self.changed = threading.Condition()
        self.held = []
        self.stopped = threading.Event()
        self.worker = threading.Thread(target=self.serve)
        self.worker.start()

    def serve(self):
        while not self.stopped.is_set():
            try:
                connection, _ = self.listener.accept()
            except TimeoutError:
                continue
            with self.changed:
                self.accepted += 1
                self.held.append(connection)
                self.changed.notify_all()

    def attempted_after(self, before):
        with self.changed:
            return self.changed.wait_for(lambda: self.accepted > before, timeout=1)

    def close(self):
        self.stopped.set()
        self.worker.join()
        self.listener.close()
        for connection in self.held:
            connection.close()


def command(binary, args, env):
    started = time.monotonic()
    run = subprocess.run([binary, *args], env=env, capture_output=True, text=True, timeout=38)
    elapsed = time.monotonic() - started
    assert run.returncode in (0, 1), (args, run.returncode, run.stderr, run.stdout)
    envelope = json.loads(run.stdout)
    assert envelope['ok'] == (run.returncode == 0), envelope
    return envelope, elapsed


def code(envelope):
    return 'ok' if envelope['ok'] else envelope['error']['code']


def close_overview(env, tier):
    if tier != 'x11-mutter':
        return
    end = time.monotonic() + 10
    while True:
        state = subprocess.run(['busctl', '--user', '--timeout=2', 'get-property',
                                'org.gnome.Shell', '/org/gnome/Shell',
                                'org.gnome.Shell', 'OverviewActive'],
                               env=env, capture_output=True, text=True, check=True)
        if state.stdout.strip() == 'b false':
            return
        assert time.monotonic() < end, 'private overview did not close'
        subprocess.run(['xdotool', 'key', 'Escape'], env=env, check=True, timeout=3)


def wait_fixture(binary, env, pid):
    end = time.monotonic() + 20
    while time.monotonic() < end:
        listed, _ = command(binary, ['list-windows'], env)
        windows = listed.get('data', [])
        if isinstance(windows, dict):
            windows = windows.get('windows', [])
        for window in windows:
            if window.get('pid') == pid:
                snap, _ = command(binary, ['snapshot', '--window-id', window['id'], '-i'], env)
                tree = snap.get('data', {}).get('tree', {})
                nodes = [tree]
                while nodes:
                    node = nodes.pop()
                    nodes.extend(node.get('children', []))
                    if node.get('role') in ('textbox', 'textfield', 'text_field') and node.get('ref_id'):
                        return window['id'], node['ref_id']
        if not listed['ok']:
            raise AssertionError(listed)
    raise AssertionError('fixture did not publish a window and editable ref')


def matrix(binary, tier, repeats, only):
    private = os.environ.get('AGENT_DESKTOP_PRIVATE_SESSION')
    assert private and os.environ.get('DISPLAY') not in (None, '', ':0', ':1', ':99')
    with tempfile.TemporaryDirectory(prefix='display-matrix-', dir=private) as directory:
        root = Path(directory)
        base = dict(os.environ, GDK_BACKEND='x11', AD_MATRIX_TEXT=str(root / 'text'))
        base.pop('WAYLAND_DISPLAY', None)
        fixture = subprocess.Popen(['/usr/bin/python3', '-c', FIXTURE], env=base)
        portal_log = root / 'portal.log'
        portal = subprocess.Popen(['/usr/bin/python3', '-c', PORTAL, str(portal_log)],
                                  env=base, stdout=subprocess.PIPE, text=True)
        silent_x11 = Silent()
        silent_wl = Silent(str(root / 'silent-wl'))
        refused_wl = socket.socket(socket.AF_UNIX)
        refused_wl.bind(str(root / 'refused-wl'))
        refused_tcp = socket.socket()
        refused_tcp.bind(('127.0.0.1', 0))
        refused_display = f'127.0.0.1:{refused_tcp.getsockname()[1] - 6000}'
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(portal.stdout, selectors.EVENT_READ)
                assert ready.select(15), 'private portal oracle did not acquire its name'
                portal_state = json.loads(portal.stdout.readline())
            window, ref = wait_fixture(binary, base, fixture.pid)
            close_overview(base, tier)
            original = base['DISPLAY']
            cases = {
                'x11': (None, original),
                'unix': (None, 'unix' + original),
                'empty-wayland': ('', original),
                'missing-wayland': (str(root / 'missing-wl'), original),
                'refused-wayland': (str(root / 'refused-wl'), original),
                'no-display': (None, None),
                'missing-x11': (None, ':99998'),
                'refused-x11': (None, refused_display),
                'silent-x11': (None, silent_x11.address),
                'silent-wayland': (silent_wl.address, original),
                'silent-wayland-no-tools': (silent_wl.address, original),
            }
            commands = {
                'displays': ['list-displays'],
                'screen': ['screenshot', str(root / 'screen.png')],
                'window': ['screenshot', '--window-id', window, str(root / 'window.png')],
                'clipboard-set': ['clipboard-set', 'matrix'],
                'clipboard-get': ['clipboard-get'],
                'focus': ['focus-window', '--window-id', window],
                'press': ['--headed', 'press', 'escape', '--window-id', window],
                'pointer': ['--headed', 'mouse-move', '--xy', '600,600'],
                'drag': ['--headed', 'drag', '--from-xy', '600,600', '--to-xy', '620,620', '--duration', '20'],
                'type': ['type', ref, 'z'],
            }
            previous = None
            failures = []
            for repetition in range(repeats):
                results = {}
                for case, (wayland, display) in cases.items():
                    if only and case not in only:
                        continue
                    env = dict(base)
                    for name, value in [('WAYLAND_DISPLAY', wayland), ('DISPLAY', display)]:
                        if value is None:
                            env.pop(name, None)
                        else:
                            env[name] = value
                    if case == 'silent-wayland-no-tools':
                        env['PATH'] = str(root / 'empty-path')
                    for name, args in commands.items():
                        if case == 'silent-wayland-no-tools' and not name.startswith('clipboard-'):
                            continue
                        before = (silent_x11.accepted, silent_wl.accepted)
                        text_before = (root / 'text').read_text() if (root / 'text').exists() else ''
                        portal_before = portal_log.read_text() if portal_log.exists() else ''
                        answer, elapsed = command(binary, args, env)
                        actual = code(answer)
                        try:
                            if case in ('no-display', 'missing-x11', 'refused-x11'):
                                assert actual == 'PLATFORM_NOT_SUPPORTED', (case, name, answer)
                                assert elapsed <= 6.3, (case, name, elapsed)
                            elif case == 'silent-x11':
                                assert actual == 'TIMEOUT', (case, name, answer)
                                assert elapsed <= 6.3, (case, name, elapsed)
                                assert silent_x11.attempted_after(before[0]), (case, name, 'no X11 attempt')
                            elif case == 'silent-wayland-no-tools':
                                assert actual == 'PLATFORM_NOT_SUPPORTED', (case, name, answer)
                                assert 'wl-clipboard' in answer['error'].get('suggestion', ''), answer
                            elif case == 'silent-wayland':
                                if name in ('clipboard-set', 'clipboard-get'):
                                    assert actual == 'TIMEOUT', (case, name, answer)
                                    assert silent_wl.attempted_after(before[1]), (case, name, 'no Wayland attempt')
                                elif name in ('focus', 'press', 'pointer', 'drag'):
                                    assert actual == 'ACTION_NOT_SUPPORTED', (case, name, answer)
                                elif name == 'window':
                                    assert actual == 'PLATFORM_NOT_SUPPORTED', (case, name, answer)
                                elif name == 'displays':
                                    expected = 'ok' if portal_state['mutter'] else 'PLATFORM_NOT_SUPPORTED'
                                    assert actual == expected, (case, name, answer)
                                elif name == 'screen':
                                    assert actual == 'ACTION_FAILED', (case, name, answer)
                                    assert portal_log.read_text() == portal_before + 'Screenshot\n'
                                elif name == 'type':
                                    assert actual == 'ok', (case, name, answer)
                            else:
                                allowed = {'ok'}
                                if tier == 'x11-mutter' and name == 'screen':
                                    allowed = {'PLATFORM_NOT_SUPPORTED'}
                                assert actual in allowed, (case, name, answer)
                            if actual == 'ok' and name == 'type':
                                assert (root / 'text').read_text() == text_before + 'z', (case, 'text oracle')
                        except AssertionError as error:
                            failures.append((repetition + 1, case, name, str(error)))
                            print(json.dumps(dict(tier=tier, run=repetition + 1, case=case,
                                                  command=name, failure=str(error))), flush=True)
                        results[f'{case}/{name}'] = actual
                        print(json.dumps(dict(tier=tier, run=repetition + 1, case=case,
                                              command=name, code=actual, elapsed=round(elapsed, 3))), flush=True)
                if previous is not None:
                    assert results == previous, 'matrix results differed between runs'
                previous = results
            assert not failures, failures
        finally:
            fixture.terminate()
            fixture.wait(timeout=5)
            portal.terminate()
            portal.wait(timeout=5)
            silent_x11.close()
            silent_wl.close()
            refused_wl.close()
            refused_tcp.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    parser.add_argument('--tier', choices=['x11-openbox', 'x11-mutter', 'wayland'], required=True)
    parser.add_argument('--repeats', type=int, default=2)
    parser.add_argument('--case', action='append')
    args = parser.parse_args()
    matrix(str(Path(args.binary).resolve()), args.tier, args.repeats, args.case)
