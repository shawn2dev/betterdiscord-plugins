# betterdiscord-plugins

BetterDiscord plugins by Shawny.

## ShawnyHelper

Reduces AFK voice channel moves caused by Discord idle/AFK handling.

**Install:** BetterDiscord → Plugins → Download → paste:

```
https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/main/ShawnyHelper.plugin.js
```

Or clone this repo and copy `ShawnyHelper.plugin.js` into your BetterDiscord plugins folder.

Updates: BetterDiscord no longer uses `@updateUrl` for third-party plugins. ShawnyHelper checks GitHub on startup and prompts when a newer version is available.

## Macro

Schedule chat messages or slash commands to a specific guild/channel at set times (24-hour clock).

**Install:** BetterDiscord → Plugins → Download → paste:

```
https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/main/Macro.plugin.js
```

**Features:**

- Run chat or `/slash` commands at a configured hour, minute, and second
- Target guild and channel IDs (or fill from the current channel)
- Repeat modes: once, daily, or every N hours
- Slash commands fire ~1–1.5s early (configurable ping lead) for bot timing
- Auto-updates from GitHub (same as ShawnyHelper)

## XpUserMenu

Adds experience add/remove submenus to the Discord user context menu. The default amount presets are 500, 1000, and 2000 XP; presets and localized command names can be edited in plugin settings.

**Install:** Copy `XpUserMenu.plugin.js` into your BetterDiscord plugins folder and enable it.

Commands are sent through Discord's internal interaction API, which is undocumented and may change without notice.
