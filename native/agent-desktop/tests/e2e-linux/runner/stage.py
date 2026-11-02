from __future__ import annotations

import hashlib
import stat
from pathlib import Path

from runner.session import _load_bounded_process

HELPER_NAME = "agent-desktop-linux-clipboard-owner"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stage_binary(source: Path, suite_dir: Path, bounded=None) -> Path:
    source = Path(source)
    bin_dir = Path(suite_dir) / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name, original in ((HELPER_NAME, source.with_name(HELPER_NAME)), ("agent-desktop", source)):
        _stage_image(original, bin_dir / name)
    target = bin_dir / "agent-desktop"
    bounded = bounded or _load_bounded_process()
    result = bounded.run_bounded([str(target), "--version"], timeout_seconds=15)
    if result.returncode != 0:
        raise RuntimeError(f"the staged binary does not answer --version: {result.stderr}")
    return target


def _stage_image(source: Path, target: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"release image not found: {source}")
    staged_sha = target.with_name(target.name + ".sha256")
    if target.exists():
        recorded = staged_sha.read_text().split()[0] if staged_sha.exists() else ""
        if recorded and recorded == _sha256(target) == _sha256(source):
            return
        raise StagedBinaryModified(
            f"the staged image at {target} does not match the recorded source hash"
        )
    source_hash = _sha256(source)
    target.write_bytes(source.read_bytes())
    target.chmod(stat.S_IRUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP)
    staged_hash = _sha256(target)
    if staged_hash != source_hash:
        raise StagedBinaryModified("the staged copy does not match the source hash")
    staged_sha.write_text(f"{staged_hash}  {source}\n")


def verify_staged(target: Path, suite_dir: Path) -> bool:
    for image in (Path(target), Path(suite_dir) / "bin" / HELPER_NAME):
        staged_sha = image.with_name(image.name + ".sha256")
        if not staged_sha.is_file() or not image.is_file():
            return False
        if staged_sha.read_text().split()[0] != _sha256(image):
            return False
    return True


class StagedBinaryModified(Exception):
    pass
