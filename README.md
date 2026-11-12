# Falconherd

A full Herdr layout for working with coding agents: your machines and their spaces in the sidebar,
an agents list that tells you who needs you, tabs and pane headers that wear each account's color,
files and git changes beside the terminal, and a status bar with the agent's usage and model.

![Falconherd](preview.png)

## Add it

Ask the agent in Herdr: "add this layout: <this repo's URL>". It copies `layouts/` and `mods/`,
merges `keys.json`, checks each mod and switches to the layout (ctrl-shift-l switches back).

Or by hand: copy `layouts/falconherd.json` and the `mods/falcon-*` folders into your Herdr home
(`~/.config/herdr-app`), merge `keys.json` into yours, then pick Falconherd in Settings → Look.

## Helpers (optional)

`helpers/install.sh` links a few small programs into `~/.local/bin`: tab names written by Claude
Haiku, readable pages for sub-agents and conversations, side chat briefs, and account usage in the
status bar. Everything else works without them.

## Accounts

Your accounts (which config folder each Claude Code or Codex account uses, its color and icon) and
the + menu's entries are set in the Accounts window: the status bar's account menu → Accounts, or the
+ menu's Edit this menu. They save to `machines/<this computer>.json` in your Herdr home.

`RECIPE.md` describes the whole layout, for building it again from scratch.

macOS and Linux first: on Windows the layout works, and the helpers need setting up by hand.
