# Player interface

Operate mode: the game is the focus. Keep the Pokemon wordmark in self-hosted Silkscreen Bold; use a quiet green-neutral shell, charcoal bezel, fine borders and restrained shadows. System sans type for controls; no decorative motion.

The emulator canvas remains160×144. Preserve10:9 and nearest-neighbor rendering. At100%, target320×288 on390×844 phones,640×576 on tall unfolded768×1024/884×1104 viewports,640×576 on1366×768 PCs and800×720 on1920×1080 PCs. These are responsive display presets, not device hardware resolutions. Short or narrow windows shrink by width while retaining the ratio. Cap the display wrapper; apply80/90/100% inside it so each setting changes the result.

Phone and tall fold layouts keep direction controls and action controls below the game. Wide desktop and short landscape layouts put the controls beside the larger game. Window resizing must not restart the core or change a save.

The user explicitly requested smaller ROM/save buttons and screen/speed selectors. ROM/save actions are24px high with10px labels. Native selects keep16px computed text and are visually scaled to63×24px (12px visible text) to avoid iPhone focus zoom;26px setting rows. The menu is260px wide with subtle borders and4px control corners; open/close icons remain32px. long instructions stay in collapsed help. SVG list/X icons have accessible names. Game buttons remain48px circles (44px on the narrowest view), with44px direction cells. A confirms, B cancels, S opens the game list, E uses the registered item; T captures a temporary moment and R restores it.

Pause and release input when opening the native menu. Closing or pressing Escape resumes play and restores focus. Keep errors visible, readable and untruncated. The chat panel stays below the console. Its message area scales with viewport height. The account button sits beside the menu and opens separate sign-in and email verification dialogs.

Ordinary SRAM/RTC stays local and .sav export is separate. T/R uses one JS-memory slot only; successful ROM boot/restart and pagehide clear it. Brief background visibility changes retain it. The menu links to the modified ROM download and uses the native file picker with .gb/.gbc filtering. The fallback picker shows all files. Multiple selected ROMs appear in a compact list, and only the chosen ROM is read and validated.

Versioned CSS/module URLs are mirrored in the service-worker shell to prevent stale markup/styles. Font license and source: https://github.com/google/fonts/tree/main/ofl/silkscreen (LICENSE.Silkscreen.txt).
