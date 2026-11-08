import hashlib
import json


class MeasurementError(RuntimeError):
    pass


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_envelope(result, operation):
    if result.termination_error:
        raise MeasurementError(f"{operation} could not terminate cleanly: {result.termination_error}")
    if result.timed_out:
        raise MeasurementError(f"{operation} exceeded its absolute subprocess timeout")
    if result.output_limited:
        raise MeasurementError(f"{operation} exceeded its subprocess capture limit")
    payload = result.stdout if result.stdout.strip() else result.stderr
    try:
        envelope = json.loads(payload)
    except json.JSONDecodeError as error:
        raise MeasurementError(f"{operation} did not return structured JSON: {error}") from error
    if not isinstance(envelope, dict):
        raise MeasurementError(f"{operation} returned a non-object JSON value")
    if result.returncode != 0 or envelope.get("ok") is not True:
        code = envelope.get("error", {}).get("code", "UNKNOWN")
        raise MeasurementError(f"{operation} failed with {code}")
    return envelope
