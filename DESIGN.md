# Player interface

The existing emulator canvas and physical control arrangement remain the authority. This is an operational extension for local files, speed and saves, not a new visual brand.

Use a light green-neutral background in the file/settings area, a charcoal game bezel, and dark readable controls. Gold marks the primary ROM action and selected values. System sans type, 16px body, no display typography, no decorative animation. Game pixels use nearest-neighbor rendering.

Mobile: screen first, direction pad on left and horizontally aligned A then B on right. A top menu button opens a native dialog containing files, saves and settings. Below A/B, S sends START for the in-game list and E sends SELECT for the registered item. A confirms and B cancels. There is no separate START/SELECT/pause row. All play targets at least44px, multitouch and cancellation release keys. Opening the menu pauses and releases input; closing resumes. Screen size is adjustable to80/90/100% without changing pixel aspect ratio. The dialog scrolls within the viewport and traps focus; landscape places controls beside the game. Visible keyboard focus, textual status and actionable errors are required.

Save files and ROMs have different labeled inputs. Pause on hidden tabs and file replacement. Saving preserves local SRAM+RTC and exports .sav; game-internal save must be performed first. Report file-save cancellation honestly.
