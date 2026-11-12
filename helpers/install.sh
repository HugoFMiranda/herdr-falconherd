#!/usr/bin/env bash
# Falconherd's optional helpers, linked into ~/.local/bin (macOS, Linux). The layout works without
# them; with them you also get: tab names written by Claude Haiku (claude-tabname), a readable page
# for a sub-agent or a conversation (claude-subagent-md, agent-transcript-md), side chat briefs sent
# to the main conversation (herdr-brief), Markdown windows rendered by glow and in a browser
# (herdr-md-glow, herdr-md-browser: glow, pandoc), and account usage in the status bar (claude-usage: Node).
# They need python3 (and node + npm for claude-usage). Run it again after moving this folder.
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
for f in claude-subagent-md agent-transcript-md claude-tabname herdr-brief herdr-md-glow herdr-md-browser; do
  ln -sf "$H/$f" "$BIN/$f"
  echo "linked $f"
done
if command -v npm >/dev/null 2>&1; then
  npm ci --prefix "$H/claude-usage" --silent
  ln -sf "$H/claude-usage/claude-usage" "$BIN/claude-usage"
  echo "linked claude-usage"
else
  echo "no npm: claude-usage left out (the status bar then shows no usage)"
fi
case ":$PATH:" in *":$BIN:"*) ;; *) echo "add $BIN to your PATH (Herdr starts programs with it)" ;; esac
