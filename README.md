# Falconherd

A Herdr layout for working with coding agents, and the mods it's made of, each one usable on its own.

## The whole thing

This is Falconherd with every mod in place, as its author uses it every day:

![Falconherd: every mod in place](falconherd/preview.png)

- **Left, top: the sidebar** ([`falcon-roost`](falcon-roost/README.md)). Colored folders (here *Acme*,
  collecting two projects by where they work) and spaces, grouped by machine once you have more than one: `web-app` has an agent that needs
  you (the red 1), `acme-api` one that's working (the spinner).
- **Left, bottom: the agents list** ([`falcon-flock`](falcon-flock/README.md)). Whoever needs you first; each
  card has its tab's name and, with Titles → With activity, what the agent is doing right now.
- **Top: the tab bar** ([`falcon-perch`](falcon-perch/README.md)). The space's tabs with their state, the `+`
  launcher, and the Files and Changes panel buttons.
- **Middle: the pane header** ([`falcon-hood`](falcon-hood/README.md)) over the agent: its account, folder and
  branch, and (on hover) fork, side chat, send a brief.
- **Right: the changes panel** ([`falcon-changes`](falcon-changes/README.md)), or the files panel
  ([`falcon-files`](falcon-files/README.md)) with its button.
- **Bottom: the status bar** ([`falcon-status`](falcon-status/README.md)): the focused agent's model, effort,
  account and usage.

Add it all with the `falconherd` folder, or take only the parts you want.

## Add one

Copy this into the agent in Herdr, with the folder you want:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this from <this repo's URL>/tree/main/<folder>
```

The agent follows that folder's `RECIPE.md`: it copies the mods (and the layout, for `falconherd`),
merges the keys, checks each mod and, for the layout, switches to it. Adding one doesn't add the others.

## What's here

| Folder | What it is |
|---|---|
| [`falconherd`](falconherd/README.md) | **The whole layout**: everything below, placed together, with its keys |
| [`falcon-roost`](falcon-roost/README.md) | **Sidebar**: your machines, colored folders and spaces (repo and branch, agents working or needing you, worktrees), a filter, menus for each |
| [`falcon-flock`](falcon-flock/README.md) | **Agents list**: who needs you first, each card in its account's color with what it's doing, snooze, settle, pin, reopen closed conversations |
| [`falcon-perch`](falcon-perch/README.md) | **Tab bar**: tabs with their account's icon and state, drag, a tab menu with Regenerate title, the side panels' buttons, and the `+` launcher |
| [`falcon-hood`](falcon-hood/README.md) | **Pane header**: the conversation's account, folder, branch, context and sub-agents; fork, side chat, send a brief, continue on another account |
| [`falcon-files`](falcon-files/README.md) | **Files panel**: a tree with git colors and a filter, a Markdown reader, and copy to another connected machine |
| [`falcon-changes`](falcon-changes/README.md) | **Changes panel**: stage with checkboxes, inline diffs, branches, fetch / pull / push / stash, commit |
| [`falcon-status`](falcon-status/README.md) | **Status bar**: the focused agent's model and effort (menus), its account and plan, 5-hour and weekly usage |
| [`helpers`](helpers/install.sh) | Optional small programs some features use (tab names, sub-agent pages, briefs, usage, Markdown rendering): `helpers/install.sh` links them into `~/.local/bin` |

Each folder has a `README.md` for people, a `RECIPE.md` for the agent that installs it (and for
building it again from scratch), and a `preview.png`. A mod folder's `mods/` also holds the small
mods it opens (the `+` popover, the Accounts window, the Markdown window); they aren't placed anywhere.

## Accounts

Claude Code and Codex accounts (which config folder each uses, its color and icon) are set in the
Accounts window, which also has the `+` menu's entries and the Titles settings. With no accounts set,
there's one Claude account (`~/.claude`) and Codex.

macOS and Linux first: on Windows the mods work, and the helpers need setting up by hand.
