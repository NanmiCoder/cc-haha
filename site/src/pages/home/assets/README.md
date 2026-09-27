# Grove hero asset

`redwood-dawn.webp` is an original background generated with the built-in image generation tool on 2026-09-26, then encoded as WebP at 1920 px wide (quality 88).

Art direction was approved from the [Agent Grove reference](https://motionsites.ai/?prompt=agent-grove). The reference screenshot is not shipped. There are no remote image requests at runtime.

## Generation prompt

Use case: photorealistic-natural. Asset type: cinematic full-screen website forest background, landscape 16:9. Create a stunning photorealistic ancient redwood forest at dawn, massive deeply ridged redwood tree trunks rising beyond the frame, one huge shadowy trunk framing the far left edge, two immense warm redwood trunks on the right, a winding narrow earth trail receding toward the center-right into luminous soft golden morning mist. Dense fine fern foliage and moss on the forest floor, dark green foreground, warm ivory shafts of light streaming diagonally from upper center-right. Deep atmospheric perspective, cathedral-like scale, realistic natural bark and exquisite photographic texture. Sophisticated cinematic color grading, dark forest-green shadows and honey-colored light, tranquil and awe-inspiring. Composition for landing page: lower left 50% has calm dark shadowed forest ground with no busy high contrast elements for a white headline overlay; upper center opens to sunlight. Wide-angle landscape photography, realistic not fantasy, restrained bloom, editorial luxury outdoor campaign. No people, no buildings, no text, no logos, no UI, no watermark. Output landscape 1920x1080 or higher.

## Rendering

The photograph remains visible as a static fallback. Three.js maps it onto a shallow relief mesh for pointer and scroll parallax; the depth is an artistic approximation, not a full model of the forest. Pollen points are positioned in 3D. The renderer is dynamically imported and stops when paused, hidden, offscreen, or reduced motion is requested. Context loss falls back to the photograph.

Implementation references: [responsive rendering](https://threejs.org/manual/pages/responsive.html), [rendering on demand](https://threejs.org/manual/pages/rendering-on-demand.html), [resource disposal](https://threejs.org/manual/pages/how-to-dispose-of-objects.html), and [particle sprites](https://threejs.org/examples/webgl_points_sprites.html).
