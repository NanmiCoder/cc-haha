use super::live_bench::{Bench, Scripts, TOOLKITS, Toolkit};

pub(in crate::actions) fn each_toolkit(check: impl Fn(Toolkit, &Bench)) {
    for toolkit in TOOLKITS {
        match Bench::open(toolkit) {
            Ok(bench) => check(toolkit, &bench),
            Err(reason) => panic!("{toolkit:?} fixture unavailable: {reason}"),
        }
    }
}

pub(in crate::actions) fn each_scripts(
    scripts: &Scripts<'_>,
    toolkits: &[Toolkit],
    check: impl Fn(Toolkit, &Bench),
) {
    for toolkit in toolkits {
        match Bench::open_scripts(*toolkit, scripts) {
            Ok(bench) => check(*toolkit, &bench),
            Err(reason) => panic!("{toolkit:?} fixture unavailable: {reason}"),
        }
    }
}
