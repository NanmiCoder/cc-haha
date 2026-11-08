#Requires -Version 5.1

Set-StrictMode -Version 2.0

function Invoke-HorizontalScrollToLeg {
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $area = Require-Target -Target (Find-Target -App $App -NativeId 'horizontal-scroll-area' -TimeoutSeconds 10) -Description 'horizontal-scroll-area'
            Invoke-Target -Target $area -Action 'scroll-to' -RequireOk -Description 'horizontal-scroll-area' | Out-Null
            $viewport = Get-Target -Target $area -Property 'bounds' -Raw
            $target = Require-Target -Target (Find-Target -App $App -NativeId 'horizontal-edge-target' -TimeoutSeconds 10) -Description 'horizontal-edge-target'
            $before = Get-Target -Target $target -Property 'bounds' -Raw
            $right = [double]$viewport['x'] + [double]$viewport['width']
            if ([double]$before['x'] -ge $right -or ([double]$before['x'] + [double]$before['width']) -le $right) {
                throw 'horizontal-edge-target was not partially clipped before scroll-to'
            }
            Invoke-Target -Target $target -Action 'scroll-to' -RequireOk -Description 'horizontal-edge-target' | Out-Null
            $fresh = Require-Target -Target (Find-Target -App $App -NativeId 'horizontal-edge-target' -TimeoutSeconds 10) -Description 'horizontal-edge-target after scroll'
            $after = Get-Target -Target $fresh -Property 'bounds' -Raw
            if ([double]$after['x'] -lt [double]$viewport['x'] -or ([double]$after['x'] + [double]$after['width']) -gt $right) {
                throw 'horizontal-edge-target remained clipped after scroll-to'
            }
        }
        Add-Pass -Leg 'interaction-horizontal-scroll-to-containment'
    } catch { Add-Fail -Leg 'interaction-horizontal-scroll-to-containment' -Reason $_.Exception.Message }
}
