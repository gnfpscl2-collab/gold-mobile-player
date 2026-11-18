# Gold Mobile Player

## Platform
web — installable on Android Chrome and iPhone Safari, also desktop.

## User and job
The user plays their own Korean Gold modified ROM on a phone and wants a separate ROM file, local file loading, adjustable speed and phone save files.

## Confirmed requirements
- User requested a new GitHub repository and support instructions for both Android and iPhone.
- Load .gb/.gbc ROM separately from .sav battery saves.
- Mobile maximum 5x, desktop maximum 10x.
- Save downloads/exports a real .sav file to the device, with local recovery storage.
- Preserve real-time clock independent of emulation speed for the Celebi schedule.
- The player links to the user-designated Drive download and opens ROM files selected from the device. Device ROMs and saves are not uploaded by the player or committed to GitHub.

## Scope choices
One player screen with touch controls, keyboard support, pause, sound, speed and local saves. Use the existing MIT core. Shared chat requires a verified Gmail or Naver address. Playing and saving work independently of chat.

## Surface
Operate mode for player controls; the original ROM artwork is the visual focus. Keep the incumbent emulator canvas and familiar handheld control arrangement. Use quiet neutral UI with one gold action accent. These routine UI choices are inferred from the functional brief; no separate brand has been requested.

- T/R captures and restores a temporary machine state only while the current ROM session remains open. No quick state persists across page close/reload or ROM restart.
- A/B/S/E/T/R are all circular colored controls.
