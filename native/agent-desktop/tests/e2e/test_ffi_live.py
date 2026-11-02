import ctypes
import pathlib
import re
import unittest

from ffi_live import EXECUTE_ARGS, EXECUTE_TIMEOUT_ARGS, Action, ref_for

HEADER = pathlib.Path(__file__).resolve().parents[2] / "crates/ffi/include/agent_desktop.h"


SCALAR_CTYPES = {
    "int32_t": ctypes.c_int32,
    "int64_t": ctypes.c_int64,
    "uint32_t": ctypes.c_uint32,
    "uint64_t": ctypes.c_uint64,
    "uint8_t": ctypes.c_uint8,
    "bool": ctypes.c_bool,
}
STRUCT_POINTER_CTYPES = {
    "AdAdapter": ctypes.c_void_p,
    "AdAction": ctypes.POINTER(Action),
}


def header_parameter_types(name):
    match = re.search(rf"^\w+ {name}\(([^)]*)\);", HEADER.read_text(), re.MULTILINE)
    if match is None:
        raise AssertionError(f"{name} is not declared in {HEADER}")
    declarations = [" ".join(part.split()) for part in match.group(1).split(",")]
    return [re.sub(r"\s*\b\w+$", "", declaration) for declaration in declarations]


def ctype_for_header_type(c_type):
    if c_type in SCALAR_CTYPES:
        return SCALAR_CTYPES[c_type]
    if c_type == "const char *":
        return ctypes.c_char_p
    if c_type == "char **":
        return ctypes.POINTER(ctypes.c_char_p)
    struct = re.fullmatch(r"(?:const )?struct (\w+) \*", c_type)
    if struct and struct.group(1) in STRUCT_POINTER_CTYPES:
        return STRUCT_POINTER_CTYPES[struct.group(1)]
    raise AssertionError(f"no ctypes mapping for header type {c_type!r}")


def header_parameter_ctypes(name):
    return [ctype_for_header_type(c_type) for c_type in header_parameter_types(name)]


class FfiLiveContractTests(unittest.TestCase):
    def test_action_layout_matches_pinned_c_abi(self):
        self.assertEqual(ctypes.sizeof(Action), 96)

    def test_execute_bindings_match_the_committed_header(self):
        self.assertEqual(EXECUTE_ARGS, header_parameter_ctypes("ad_execute_by_ref"))
        self.assertEqual(EXECUTE_TIMEOUT_ARGS,
                         header_parameter_ctypes("ad_execute_by_ref_timeout"))

    def test_ref_lookup_reads_typed_native_identifier(self):
        envelope = {
            "data": {
                "tree": {
                    "role": "window",
                    "children": [{
                        "role": "button",
                        "native_id": {"kind": "AX_IDENTIFIER", "value": "delayed-button"},
                        "ref_id": "@snapshot:e3",
                    }],
                }
            }
        }
        self.assertEqual(ref_for(envelope, "delayed-button"), "@snapshot:e3")


if __name__ == "__main__":
    unittest.main()
