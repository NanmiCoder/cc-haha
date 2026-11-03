"""Keep recorded evidence independent and compatible with each leg's contract."""
import ast
import unittest
from pathlib import Path

from runner.legs import ORACLE_NAMES, leg_by_id


class ScenarioOracleContractTests(unittest.TestCase):
    def test_constant_observation_channels_are_declared_oracles(self):
        problems = []
        for path in (Path(__file__).parent / "scenarios").glob("*.py"):
            tree = ast.parse(path.read_text())
            for function in (node for node in tree.body if isinstance(node, ast.FunctionDef)):
                ids = [decorator.args[0].value for decorator in function.decorator_list
                       if isinstance(decorator, ast.Call)
                       and isinstance(decorator.func, ast.Name)
                       and decorator.func.id == "implementation"]
                allowed = leg_by_id(ids[0]).oracles if ids else ORACLE_NAMES
                for call in (node for node in ast.walk(function) if isinstance(node, ast.Call)):
                    if not (isinstance(call.func, ast.Attribute)
                            and isinstance(call.func.value, ast.Name)
                            and call.func.value.id == "ctx"
                            and call.func.attr in ("before", "after", "restored")
                            and call.args and isinstance(call.args[0], ast.Constant)):
                        continue
                    channel = call.args[0].value.partition(".")[0]
                    if channel not in allowed:
                        problems.append(f"{path.name}:{call.lineno}: {channel} outside {allowed}")
        self.assertEqual(problems, [])
