# Design System Specification: The Technical Atelier

## 1. Overview & Creative North Star
### The Creative North Star: "The Digital Archivist"
This design system moves away from the sterile, cold "high-tech" aesthetics typical of developer tools. Instead, it draws inspiration from high-end editorial design and architectural drafting—spaces designed for focus, tactile quality, and longevity. We are building a "Digital Archivist" experience: a workspace that feels like an expensive linen-bound notebook or a well-lit studio.

By utilizing intentional asymmetry, generous white space, and a rejection of traditional "boxed" layouts, we create an environment for deep work. The interface doesn't scream for attention; it recedes, providing a calm, authoritative stage for the developer’s code.

---

## 2. Colors & Surface Philosophy
The palette is rooted in "Warm Paper" (`#FAF9F5`) and "Dark Graphite" (`#141413`). This high-contrast but warm-toned foundation reduces eye strain during long coding sessions.

### The "No-Line" Rule
Traditional 1px borders are prohibited for structural sectioning. To define separate functional areas (e.g., a sidebar from a code editor), use background color shifts. 
- **Application:** Place a `surface_container_low` sidebar directly against a `surface` main content area. The 4% tonal shift is sufficient for the human eye to perceive a boundary without creating visual "noise."

### Surface Hierarchy & Nesting
Treat the UI as a physical stack of paper and glass.
- **Base Layer:** `surface` (#FAF9F5) - The desk.
- **Secondary Panels:** `surface_container_low` (#F4F4F0) - Inset utility areas.
- **Floating Elements:** `surface_container_lowest` (#FFFFFF) - Active cards or modals.
- **Nesting:** Always move one tier up or down when nesting. A card (`surface_container_lowest`) should never sit on a background of the same color; it should sit on `surface_container_low` to create a natural, "lifted" appearance.

### Glassmorphism & Tonal Depth
For floating utilities (like a command palette or hover-state popover), use `surface_container_lowest` at 85% opacity with a `20px` backdrop blur. This allows the underlying code and "warm paper" texture to bleed through, maintaining a sense of place.

---

## 3. Typography: Editorial Authority
The typography system pairs the modernist clarity of **Manrope** for high-level structure with the functional precision of **Inter** for data-heavy tasks.

*   **Display & Headlines (Manrope):** These are the "Wayfinders." Use `display-md` for empty states and `headline-sm` for major module titles. The slightly wider tracking of Manrope provides an expensive, editorial feel.
*   **Body & Labels (Inter):** Inter is our workhorse. Use `body-md` for standard UI text. It is optimized for screen readability and feels native to high-end macOS applications.
*   **Code (Monospace):** For terminal output and code blocks, use a high-quality monospace font (SF Mono or JetBrains Mono) at `0.875rem` to match `body-md` visual weight.

---

## 4. Elevation & Depth
We reject the "drop shadow" defaults of the web. Depth is an atmospheric quality, not a structural crutch.

*   **The Layering Principle:** Avoid shadows for static components. Use the `surface-container` tiers to create hierarchy.
*   **Ambient Shadows:** For active floating states (Modals), use a multi-layered shadow:
    *   `box-shadow: 0 4px 20px rgba(27, 28, 26, 0.04), 0 12px 40px rgba(27, 28, 26, 0.08);`
    *   The color is derived from `on_surface`, ensuring the shadow feels like a natural obstruction of light on warm paper.
*   **The Ghost Border:** When accessibility requires a container boundary, use `outline_variant` at 20% opacity. It should be felt, not seen.

---

## 5. Components

### Buttons
- **Primary:** `primary` (#8F482F) background with `on_primary` (#FFFFFF) text. 
- **Secondary:** `surface_container_high` background. No border.
- **Signature Styling:** Use `radius-DEFAULT` (8px). For Primary buttons, apply a subtle linear gradient from `primary` to `primary_container` (top to bottom) to give the button a "pressed ink" physical quality.

### The Chat Composer (Input)
- **Styling:** Large `radius-xl` (16px) corners. 
- **Background:** `surface_container_lowest` (#FFFFFF).
- **Definition:** Instead of a heavy border, use a `1px` "Ghost Border" of `outline_variant` at 15% opacity. When focused, increase the opacity of the ghost border to 40%—do not use a glow.

### Chips & Status
- **Success:** `tertiary_container` (#677B4E) with `on_tertiary_container` text.
- **Running/Warning:** `primary_fixed` (#FFDBD0) with `on_primary_fixed` text.
- **Shape:** Use `radius-full` for a soft, pill-shaped aesthetic that contrasts against the structured grid of code.

### Cards & Lists
- **The No-Divider Rule:** Explicitly forbid horizontal lines between list items. Separate items using `8px` of vertical white space or a hover state that shifts the background to `surface_container_highest`.
- **Nesting:** Cards must use `radius-lg` (12px) and be placed on `surface_container_low` for maximum legibility.

### Terminal & Code Blocks
- **Container:** `surface_dim` (#DBDAD6) to provide a "recessed" look. 
- **Text:** `on_surface` for standard output, `secondary` (#2D628F) for links/permissions.

---

## 6. Do's and Don'ts

### Do
- **Embrace Asymmetry:** Align primary actions to the right, but keep "Brand Moments" (like a logo or status indicator) intentionally offset to break the "Bootstrap" feel.
- **Use "Warmth" as a Tool:** Use the `primary` (Antique Brass) color sparingly. It should highlight intent, not decorate.
- **Prioritize Breathing Room:** If a layout feels "busy," increase the spacing scale rather than adding borders.

### Don't
- **No 100% Black:** Never use `#000000`. Use `on_background` (#1B1C1A) to maintain the "ink on paper" softness.
- **No Sharp Corners:** Avoid `0px` or `2px` radii. They feel clinical and "un-designed" in this context.
- **No "Gaming" Effects:** Avoid neon glows, heavy blurs, or high-saturation blues. If it looks like a dashboard for a spaceship, it's wrong. It should look like a dashboard for a master craftsman.

### Accessibility Note
While we use subtle tonal shifts, always ensure the `on_surface` text vs `surface_container` maintains a minimum 4.5:1 contrast ratio for body text. Use `outline` (#87736D) for iconography to ensure clarity against the warm background.