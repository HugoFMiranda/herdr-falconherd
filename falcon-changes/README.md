# Falcon Changes

A git changes panel for the Herdr desktop app: the focused pane's repo, its branch and how far it is
from upstream, Staged and Changes lists with a checkbox per file, diffs inline under each file, and a
commit box.

![Falcon Changes](preview.png)

## Add it

Ask the agent in Herdr:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod from <this repo's URL>/tree/main/falcon-changes
```

It ships with: Nothing else.

## Use

- Tick a file to stage it (untick to unstage); click it for its diff under it; discard asks first.
- The branch button switches or creates a branch; fetch, pull, push, stash and unstash in the header.
- Commit, or Commit & push.

Part of [Falconherd](../falconherd/README.md), the layout that puts all of these together.
