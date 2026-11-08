import os,subprocess,json,ctypes as C
import gi
from gi.repository import Gio,GLib
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
reply=bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetConnectionUnixProcessID',GLib.Variant('(s)',('org.freedesktop.DBus',)),None,Gio.DBusCallFlags.NONE,3000,None)
pids={reply.unpack()[0]}
if not os.environ.get('WAYLAND_DISPLAY'):
    check=subprocess.check_output(['xprop','-root','_NET_SUPPORTING_WM_CHECK'],text=True).split()[-1]
    class Spec(C.Structure):
        _fields_=[('client',C.c_ulong),('mask',C.c_uint)]
    class Value(C.Structure):
        _fields_=[('spec',Spec),('length',C.c_long),('value',C.c_void_p)]
    x11=C.CDLL('libX11.so.6')
    res=C.CDLL('libXRes.so.1')
    x11.XOpenDisplay.argtypes=[C.c_char_p]
    x11.XOpenDisplay.restype=C.c_void_p
    x11.XCloseDisplay.argtypes=[C.c_void_p]
    res.XResQueryClientIds.argtypes=[C.c_void_p,C.c_long,C.POINTER(Spec),C.POINTER(C.c_long),C.POINTER(C.POINTER(Value))]
    res.XResGetClientPid.argtypes=[C.POINTER(Value)]
    res.XResGetClientPid.restype=C.c_int
    res.XResClientIdsDestroy.argtypes=[C.c_long,C.POINTER(Value)]
    display=x11.XOpenDisplay(None)
    assert display
    spec=Spec(int(check,0),2)
    count=C.c_long()
    ids=C.POINTER(Value)()
    res.XResQueryClientIds(display,1,C.byref(spec),C.byref(count),C.byref(ids))
    assert count.value==1 and ids
    owner=res.XResGetClientPid(C.byref(ids[0]))
    assert owner>0
    pids.add(owner)
    res.XResClientIdsDestroy(count,ids)
    x11.XCloseDisplay(display)
    path='/tmp/.X11-unix/X'+os.environ['DISPLAY'].split(':')[-1].split('.')[0]
else:
    path=os.path.join(os.environ['XDG_RUNTIME_DIR'],os.environ['WAYLAND_DISPLAY'])
inodes=set()
for line in open('/proc/net/unix'):
    words=line.split()
    if len(words)>=8 and words[7] in (path,'@'+path) and int(words[3],16)&0x10000:
        inodes.add('socket:['+words[6]+']')
for pid in os.listdir('/proc'):
    if not pid.isdigit():continue
    try:
        if any(os.readlink('/proc/'+pid+'/fd/'+fd) in inodes for fd in os.listdir('/proc/'+pid+'/fd')):
            pids.add(int(pid))
    except (FileNotFoundError,PermissionError):pass
assert len(pids)>=2
print(json.dumps(sorted(pids)))
