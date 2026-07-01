---
name: runtime-particle-builder
description: Runtime Particle builder guide for AI-generated GameGraph particles. Use when creating particles from C# code instead of hand-authored .effect files, generating procedural VFX, building client-only GameGraph previews, configuring sprite/mesh/beam/ribbon emitters, or exporting debug .effect files from runtime builder output.
whenToUse: When creating particles from C# code, generating procedural VFX, building client-only GameGraph previews, configuring emitters, or exporting debug .effect files from runtime builder output.
allowedTools: Bash, Read, Glob, Grep, Edit, Write
---

# Runtime Particle Builder Skill

Use this skill when the task is to generate or tune a particle effect directly in C# code. This is for client-side visual effects and previews, not server-authoritative gameplay state.

System reference: `docs/systems/GameGraphAudioParticle.md`.
API reference: `api/client/GameGraph_ResourceSystem.cs`.
Sample project: `map_templates/code_sample/src/RuntimeParticleBuilderSample/`.

## When To Use

- The user asks AI to create a particle without preparing a `.effect` file.
- The effect is procedural, temporary, or part of a GameGraph/code sample.
- The task needs sprite, mesh, beam, or ribbon emitters configured by code.
- The user wants Debug export to `.effect` after previewing a runtime-built effect.

Prefer existing `ParticleSystem.Load("effect/.../particle.effect")` when the project already has an authored effect asset and only needs playback.
Prefer `ActorParticle` / `GameDataActorParticle` when the effect belongs to Unit/Ability/Buff data and should be managed by ActorScope.

## Core Rules

- Runtime particle builder APIs are client-only. Wrap use in `#if CLIENT`.
- Create with `ParticleSystem.CreateRuntime()`, then add emitters with `AddSpriteEmitter()`, `AddMeshEmitter(...)`, `AddBeamEmitter(...)`, or `AddRibbonEmitter()`.
- Attach with `particle.AddToNode(node)` and control playback with `ParticleSystem.Play/Stop/SetTickSpeed/SetUnitScale`.
- `ExportEffect(...)` is Debug-only. It writes under the current project's `res/RuntimeParticles` by default and returns `ParticleEffectExportResult.NotDebugMode` outside Debug.
- Do not rely on runtime particles for server synchronization. If a server event should trigger a visual, synchronize the gameplay event or replicated node, then create the particle locally on the client.
- Use texture/resource paths relative to `res/`, for example `effect/custom/spark.png`. Do not prefix paths with `res/` in code.
- Prefer one clear source of initial motion. Do not casually combine `emitVelocity: true` on a shape location with a large `Velocity.Range(...)`; the two velocities add together and can make particles fly much farther than intended.

## Minimal Pattern

```csharp
#if CLIENT
using GameCore.ResourceType;
using GameGraph.NodeSystem;
using GameGraph.ResourceSystem;
using System.Numerics;

static Node CreateSparkBurst(Node parent)
{
    var particle = ParticleSystem.CreateRuntime();

    var sparks = particle.AddSpriteEmitter()
        .Timing(duration: 0.9f, loops: 1, localSpace: true);
    sparks.Spawn.Burst(64);
    sparks.Lifetime.Range(0.35f, 0.8f);
    sparks.Location.Range(new Vector3(-28, -28, 30), new Vector3(28, 28, 85));
    sparks.Velocity.Range(new Vector3(-130, -130, 20), new Vector3(130, 130, 180));
    sparks.Acceleration.Constant(new Vector3(0, 0, -180));
    sparks.Size.Range(new Vector3(6), new Vector3(16), singleRandom: true);
    sparks.Size.OverLife(1.0f, 0.05f);
    sparks.Rotation.Range(0, 360).RateRange(-220, 220);
    sparks.Color.OverLife(
        Color.FromArgb(255, 255, 220, 90),
        Color.FromArgb(0, 255, 80, 20));
    sparks.Material
        .Texture(ParticleTextureSlot.Diffuse, (ResourceTexture)"effect/effect_new1/effect_jiguang/eff_jiguang02/uv_once_t_flare.png")
        .Blend(ParticleBlendMode.AddAlpha)
        .UseVertexColor();

    var node = parent.CreateChild("SparkBurst")!;
    particle.AddToNode(node);
    ParticleSystem.Play(node);
    return node;
}
#endif
```

## Builder Checklist

- Timing: `Timing(...)`, `Duration(...)`, `Loops(...)`, `Delay(...)`, `LocalSpace(...)`, `Prewarm(...)`.
- Spawn: `Spawn.Rate(...)`, `Spawn.Burst(...)`, `Spawn.ClearBursts()`.
- Lifetime and shape: `Lifetime.Constant/Range(...)`, `Size.Constant/Range/OverLife(...)`, `Color.Constant/OverLife(...)`.
- Motion: `Location.Box/Sphere/Cylinder/Cone/MeshSurface(...)`, `Velocity.Range/ScaleOverLife/AbsoluteOverLife/Orbit(...)`, `Acceleration.Constant/Range(...)`.
- Orientation: `Facing(...)`, `ScreenAlignment(...)`, `AxisLock(...)`, `Stretched(...)`, `Rotation.Range/RateRange/RateOverLife(...)`.
- Material: `Material.Texture(...)`, `Blend(...)`, `UseVertexColor(...)`, `UseMask(...)`, `UseNoise(...)`, `UseDissolve(...)`, `SoftParticle(...)`.
- Type-specific: `SubUV.Grid/Frame/Random(...)`, `Mesh.Model/Options/RotationRange(...)`, `Beam.Points/Options/Tiling/Taper/Noise(...)`, `Ribbon.Options(...)`.

## Debug Export

```csharp
#if CLIENT
var result = particle.ExportEffect("RuntimeParticles/MyEffect", overwrite: true);
if (result.IsSuccess)
{
    Game.Logger.LogInformation("Particle exported: {Path}", result.Data);
}
else
{
    Game.Logger.LogWarning("Particle export failed: {Result}", result.Result);
}
#endif
```

Use export only as a debug convenience. The primary runtime path should still work without an exported `.effect` file.

## Verification

For visual checks, use client-only debug when possible:

1. Build the project with `Client-Debug`.
2. Copy the fresh `GameEntry.dll` to `ui/AppBundle/managed/GameEntry.dll` if launching outside the editor.
3. Start client-only debug and capture a screenshot.
4. Check the newest client log if textures, models, or exported files do not appear.
