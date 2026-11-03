from __future__ import annotations

from pathlib import Path


def stat_fields(text: str) -> tuple[int, int, str]:
    left = text.index("(")
    right = text.rindex(")")
    fields = text[right + 2:].split()
    return int(fields[19]), int(fields[2]), text[left + 1:right]


def environment(data: bytes) -> dict[str, str]:
    return dict(item.decode(errors="surrogateescape").split("=", 1)
                for item in data.split(b"\0") if b"=" in item)


def facts(pid: int, root: Path = Path("/proc")) -> tuple[int, int, str, dict]:
    directory = root / str(pid)
    first = stat_fields((directory / "stat").read_text())
    env = environment((directory / "environ").read_bytes())
    if stat_fields((directory / "stat").read_text()) != first:
        raise ProcessLookupError(f"process generation changed: {pid}")
    return (*first, env)


def may_match(pid: int, comm: str, names) -> bool:
    if any(comm.casefold() == name.casefold()[:15] for name in names):
        return True
    if "python" not in comm.casefold():
        return False
    try:
        args = (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\0")
    except (FileNotFoundError, PermissionError):
        return True
    return any(Path(arg.decode(errors="surrogateescape")).name in names for arg in args if arg)


def members(runtime_dir: Path) -> list[tuple[int, int, str]]:
    result = []
    for directory in Path("/proc").iterdir():
        if not directory.name.isdecimal():
            continue
        try:
            start, _, comm, env = facts(int(directory.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if env.get("XDG_RUNTIME_DIR") == str(runtime_dir):
            result.append((int(directory.name), start, comm))
    return sorted(result)
