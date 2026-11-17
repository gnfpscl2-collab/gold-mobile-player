# Player interface

Operate mode: the game is the focus. Keep the Pokemon wordmark in self-hosted Silkscreen Bold; use a quiet green-neutral shell, charcoal bezel, fine borders and restrained shadows. System sans type for controls; no decorative motion.

The emulator canvas remains160×144. Preserve10:9 and nearest-neighbor rendering. At100%, target320×288 on390×844 phones,640×576 on tall unfolded768×1024/884×1104 viewports,640×576 on1366×768 PCs and800×720 on1920×1080 PCs. These are responsive display presets, not device hardware resolutions. Short or narrow windows shrink by width while retaining the ratio. Cap the display wrapper; apply80/90/100% inside it so each setting changes the result.

Phone and tall fold layouts keep direction controls and action controls below the game. Wide desktop and short landscape layouts put the controls beside the larger game. Window resizing must not restart the core or change a save.

Menu actions, select boxes and open/close icons are32px high as requested. Use12px action labels and11px supporting labels. Native select text remains16px to avoid iPhone focus zoom. The menu is300px wide with subtle borders and5px control corners; long instructions stay in collapsed help. SVG list/X icons have accessible names. Game buttons remain48px circles (44px on the narrowest view), with44px direction cells. A confirms, B cancels, S opens the game list, E uses the registered item; T captures a temporary moment and R restores it.

Pause and release input when opening the native menu; closing/Escape resumes and restores focus. Keep errors visible, readable and untruncated. ROM names and routine main-screen status remain hidden; the footer shows only the numeric release.

Ordinary SRAM/RTC stays local and .sav export is separate. T/R uses one JS-memory slot only; successful ROM boot/restart and pagehide clear it. Brief background visibility changes retain it. Drive loading uses the verified fixed ROM and the website/API-restricted public browser key; device file loading remains available.

Versioned CSS/module URLs are mirrored in the service-worker shell to prevent stale markup/styles. Font license and source: https://github.com/google/fonts/tree/main/ofl/silkscreen (LICENSE.Silkscreen.txt).
