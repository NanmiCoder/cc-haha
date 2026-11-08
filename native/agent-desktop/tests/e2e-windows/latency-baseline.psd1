@{
    <#
        R18b's committed per-leg p99 store. No positive Assert-Effect leg
        registered with Register-Legs has been costed: U15's cost run,
        which is supposed to rewrite Legs with one entry per registered
        leg name, has not been taken, and that per-leg data does not
        exist anywhere in this repository. Inventing it here would be
        the fabricated baseline this file's own discipline forbids.

        What does exist, committed 2026-08-17, is
        `probes/windows/24-fixture-e2e/captures/cost-baseline-devbox.json`
        (min-of-seven, warm-up discarded) - four whole `agent-desktop`
        CLI invocations, not harness Assert-Effect legs: `snapshot --app
        notepad.exe -i`, `snapshot --app explorer.exe -i`, `list-apps`,
        `list-windows`. The four entries below key each command exactly
        as measured (not as any Register-Legs name, because none of
        these four ran inside this harness) and take its `max_ms` as a
        real, dated stand-in for a p99 a seven-sample capture cannot
        actually produce. This raises Initialize-NoEffectWindow's
        1.5x-of-max guard off a real number instead of the arbitrary
        BootstrapP99Ms fallback, but every leg name Register-Legs
        actually uses across `tests/e2e-windows/scenarios/*.ps1` is
        still absent from this table, and this comment records that gap
        rather than paper over it. Replace these four entries with
        U15's real per-leg run when it lands.
    #>
    BootstrapP99Ms = 2500
    Legs           = @{
        'snapshot --app notepad.exe -i'  = 184.7
        'snapshot --app explorer.exe -i' = 82.2
        'list-apps'                      = 24.0
        'list-windows'                   = 76.4
    }
}
