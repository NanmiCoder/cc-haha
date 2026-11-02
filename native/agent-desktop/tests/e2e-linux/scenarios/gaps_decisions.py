from runner.legs import REGISTRY, implementation, implementations


def unavailable(ctx):
    raise NotImplementedError(ctx.leg.reason)


_registered = implementations()
for _leg in REGISTRY:
    if _leg.id.startswith("gaps.") and _leg.disposition in ("owner-decision", "outstanding") and _leg.id not in _registered:
        implementation(_leg.id)(unavailable)
