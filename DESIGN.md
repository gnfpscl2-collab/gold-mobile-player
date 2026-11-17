# Player interface

The existing emulator canvas and physical control arrangement remain the authority. This is an operational extension for local files, speed and saves, not a new visual brand.

Use a light green-neutral background in the file/settings area, a charcoal game bezel, and dark readable controls. Gold marks the primary ROM action and selected values. System sans type for16px body and controls, with Silkscreen Bold reserved for the Pokemon header. No decorative animation. Game pixels use nearest-neighbor rendering.

Mobile: screen first, direction pad on left and horizontally aligned A then B on right. A top menu button opens a native dialog containing files, saves and settings. Below A/B, S sends START for the in-game list and E sends SELECT for the registered item. A confirms and B cancels. There is no separate START/SELECT/pause row. All play targets at least44px, multitouch and cancellation release keys. Opening the menu pauses and releases input; closing resumes. Screen size is adjustable to80/90/100% without changing pixel aspect ratio. The dialog scrolls within the viewport and traps focus; landscape places controls beside the game. Visible keyboard focus, textual status and actionable errors are required.

Save files and ROMs have different labeled inputs. Pause on hidden tabs and file replacement. Saving preserves local SRAM+RTC and exports .sav; game-internal save must be performed first. Report file-save cancellation honestly.

The header reads Pokemon in self-hosted Silkscreen Bold, a chunky pixel face. Body and controls retain the system sans family. No tagline or ROM filename appears during play. Routine status messages live inside the menu; actionable errors remain visible outside. The footer shows only the numeric release version. Font source: https://github.com/google/fonts/tree/main/ofl/silkscreen (SIL OFL, included as LICENSE.Silkscreen.txt).

Menu ROM loading first offers the fixed Google Drive modified ROM, followed by an external folder link and a device file fallback. The filename stays hidden during play. Download progress and failures remain textual; download errors never replace the current ROM or save.

All six action buttons are circles in a two-column, three-row grid: gold A confirms, red B cancels; green S opens the game menu, blue E uses the registered item; orange T captures a temporary moment and purple R restores it. Targets are57px (50px on narrow screens), with a compact local HH:mm:ss caption after capture. T/R never send Game Boy joypad keys. The single temporary slot lives only in JS memory and clears on every successful ROM boot and pagehide; background visibility changes retain it. Ordinary SRAM/RTC and .sav flows stay separate.

The header menu trigger is a44px list SVG icon with an accessible name; the close control is an X icon. The native menu dialog is capped at320px with12px padding,13px action labels and44px targets. Device ROM and resume shareone row. Long save/install/speed guidance and the folder link live in collapsedhelp. Select text stays16px to avoid iPhone focuszoom. Routine statuses use one short line; error recovery remains visible and untruncated. At390x844 the default menu content fell from1015px to523px.

Versioned CSS and module URLs are mirrored in the service-worker shell so cached earlier menu styles cannot mix with updated markup.
