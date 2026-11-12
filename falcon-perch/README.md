# Falcon Perch

A tab bar for the Herdr desktop app. Each tab wears its account's icon and color (or its
program's icon) and shows what its agent is doing: a spinner while it works, a red dot when it needs
you, a check when it's done. Settled tabs wait in "N away"; the side panels' buttons and the `+`
launcher sit on the right.

![Falcon Perch](preview.png)

## Add it

Ask the agent in Herdr:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod from <this repo's URL>/tree/main/falcon-perch
```

It ships with: falcon-launch (the `+` popover) and falcon-roster (the Accounts window, from the popover's Edit this menu).

## Use

- Click a tab to show it, drag to reorder, middle-click or × to close, the wheel steps through tabs.
- Right-click a tab: Rename, Regenerate title (Claude Haiku names it from its conversation), New tab,
  Close, each with its key.
- With Titles → Tab names: Claude Haiku (the Accounts window, or the profile's `titles.tabs`), a tab
  without a name you gave it is named from its conversation at 3 messages and again at 10, while it
  keeps that name.
- Each space remembers which side panel it showed.
- Keys: `Ctrl+Space` then `R` (regenerate the title), `L` (previous tab), `F` / `C` (Files / Changes
  panel; again hides it); `Alt+Shift+Left` / `Right` (move the tab).

Part of [Falconherd](../falconherd/README.md), the layout that puts all of these together.
