# Desktop Pets

Desktop Pets are optional companions that live in a small transparent window outside the main app. They reflect a few useful session states, provide a quick way back to active sessions, and can be replaced with your own local artwork.

Pets are an **Electron Desktop feature**. They do not appear in H5 or the browser-only Web UI.

![Desktop Pet settings with the four built-in companions and appearance controls](../../images/desktop_ui/14_pet_settings_overview.png)

## Enable a pet

1. Open **Settings → Pets**.
2. Turn on **Show desktop pet**.
3. Choose one of the four built-in companions:
   - **Dada**, the coding companion;
   - **Huhu**, the planning companion;
   - **Bubu**, the fixing companion;
   - **Huihui**, the building companion.
4. Adjust the size between `96px` and `192px`.
5. Choose whether to play animations and show the active-task panel.

The selected pet, size, window position, animation preference, and task-panel preference are restored between launches.

## Interact with the floating pet

| Action | Result |
|---|---|
| Move the pointer near an idle pet | Its gaze follows the pointer; entering the pet also triggers a short jump |
| Click the pet | Bring the main Claude Code Haha window forward and play a wave |
| Drag the pet | Move the floating window; the pet runs in the drag direction |
| Right-click the pet | Open the menu for closing the pet window |
| Click the numbered task badge | Expand the active-session panel |
| Click a session in the panel | Return to that session in the main window |
| Click the arrow below the task list | Collapse the panel back to the numbered badge |

The pet can visibly distinguish working, waiting for you, failed, and idle states. The panel is a navigator, not an approval surface: return to the main app to handle any pending interaction, approve or deny a tool, stop work, or inspect full output.

When there are no active sessions, the task panel stays hidden. Disabling **Show active task panel** keeps active work behind the numbered badge instead of removing or stopping it.

The animation switch affects the pet only. Turning it off does not stop sessions. Claude Code Haha also respects the operating system’s reduced-motion preference.

## Create a custom pet

Select **Add pet** under **Your pets**. The creation dialog offers two working local import paths and shows a third, currently unavailable AI path.

![Custom Pet creation dialog with local image, sprite-sheet, and unavailable AI options](../../images/desktop_ui/15_pet_create_methods.png)

Before choosing a file, enter:

- a Pet ID of at most 73 characters, containing only lowercase letters, numbers, and single hyphens, such as `docs-helper`;
- a display name;
- a short description.

The ID must be unique among your custom pets.

### Option 1: animate one image

This is the recommended path for most users.

Use a static image with:

- PNG or WebP format;
- a transparent background for the cleanest floating-window result;
- width and height between `32px` and `4096px`;
- no more than `16,777,216` total pixels;
- a file size no larger than `8MB`.

Claude Code Haha copies and validates the image locally, then adds lightweight breathing, floating, and status motion. It does not invent new action frames, and it does not call the model selected for chat.

### Option 2: import a v2 animation atlas

Use this path only when you already have a correctly prepared frame atlas.

The atlas must be a static PNG or WebP with:

| Property | Required value |
|---|---|
| Full size | Exactly `1536×2288` |
| Grid | `8` columns × `11` rows |
| Cell size | `192×208` |
| Spacing | No padding or gaps between cells |
| Background | Transparent |

Rows are assigned to idle, run right, run left, wave, jump, failed, waiting, working, review, and two rows containing 16 gaze directions. The review row is part of the asset format; its presence does not guarantee that the current runtime will surface a separate review state.

Every row may use fewer than eight visible action frames, but the grid dimensions and row positions must remain unchanged.

### AI animation is not available

**AI-generate full animation** is displayed as an unavailable future path. It requires a separate image-generation service and does not fall back to the current chat model. A disabled card in this dialog is therefore expected behavior, not a provider configuration error.

After a successful import, the new pet is selected automatically and appears under **Your pets**.

![A locally imported custom pet selected in Desktop Pet settings](../../images/desktop_ui/16_pet_custom_result.png)

## Storage and removal

Custom pet packages are stored under:

```text
${CLAUDE_CONFIG_DIR:-~/.claude}/cc-haha/pets
```

Use **Open folder** in Pet settings to open the resolved directory. This is also the current removal path:

1. Select a built-in pet first if the package you are removing is active.
2. Open the custom pet folder.
3. Remove only the custom pet’s own package directory.
4. Return to Pet settings and select **Refresh**.

Closing or disabling the floating window does not delete a custom pet. If a selected package goes missing, the app falls back to a built-in pet.

The loader skips invalid or unsafe packages and reports how many folders could not be loaded. Do not replace package files while an import is still running, and avoid symbolic links or unsupported animated image formats.

## Privacy, safety, and boundaries

- Image selection, validation, copying, and lightweight animation are local operations.
- Importing a pet does not send the image to the selected chat model.
- A pet can show summarized task state and navigate to a session, but it cannot approve permissions, answer model questions, or control a task directly.
- Pets do not run in H5, IM integrations, or a browser-only deployment.
- The pet observes the local Desktop service; it is not a cloud monitor and does not stay active after the Desktop app exits.
- Always-on-top behavior, dragging across displays, and window placement can vary by operating system and desktop environment.
- A successful application build does not by itself prove pet-window behavior on every supported operating system.

If the pet does not move, check both **Play animations** and the operating system’s reduced-motion setting. If it does not appear at all, turn **Show desktop pet** off and on once, then restart the Desktop app before editing stored files manually.
