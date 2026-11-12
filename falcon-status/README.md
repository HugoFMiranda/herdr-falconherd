# Falcon Status

A status bar for the Herdr desktop app, about the focused agent: its model and effort (both menus),
its account with its plan, and its 5-hour and weekly usage with when they reset; the machine and the
agents count on the left.

![Falcon Status](preview.png)

## Add it

Ask the agent in Herdr:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod from <this repo's URL>/tree/main/falcon-status
```

It ships with: falcon-roster (the Accounts window: accounts, the + menu's entries, Titles).

## Use

- Pick a model or effort from their menus: the command is pasted into the conversation for you to
  send.
- The account menu: switch the conversation to another account, or open the Accounts window.
- `Ctrl+Shift+G`: the usage breakdown.
- Usage comes from the claude-usage helper (Node; see the repo's helpers).

Part of [Falconherd](../falconherd/README.md), the layout that puts all of these together.
