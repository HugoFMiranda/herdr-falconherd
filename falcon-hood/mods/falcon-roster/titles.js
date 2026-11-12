// Settings → Titles: where tab names and the agents list's titles come from. Herdr's way by default;
// Claude Haiku (on the conversation's own account, so it counts against its limits) when picked.
// Saved in this computer's profile ("titles"); the tab bar and the agents list read it from there.
import { v_flex, h_flex } from "gpui-base";
import { TITLE_CHOICES, titleSettings } from "./core.js";
import { headingRow, about, note, title, segmented } from "./ui.js";
import { changed, status } from "./store.js";

const LABELS = {
  tabs: { herdr: "Herdr's", haiku: "Claude Haiku" },
  cards: { tab: "Tab name only", activity: "With activity", haiku: "With Haiku summary" },
};

function pick(m, key, value, cx) {
  m.data = { ...m.data, titles: { ...(m.data.titles ?? {}), [key]: value } };
  changed(m, cx);
}

export function titlesSection(m, t) {
  const now = titleSettings(m.data);
  // Each choice: its name and hint (above the row's divider, as Herdr's own Settings rows), its picker.
  const choice = (key, name, help) => h_flex().id(`ti-${key}`).w_full().gap(16).py(12).items_center().border_b(1).border_color(t.border)
    .child(v_flex().flex_1().min_w(0).gap(3).child(title(t, name)).child(note(t, help)))
    .child(segmented(t, `ti-${key}-pick`, TITLE_CHOICES[key].map((v) => [v, LABELS[key][v]]), now[key], (v, cx) => pick(m, key, v, cx)));
  const tabsHelp = now.tabs === "haiku"
    ? "A tab without a name you gave it is named from its conversation once it has 3 messages, and again at 10 (only while it still has that name). A name you type is never replaced."
    : "Tabs keep the names Herdr gives them, or yours.";
  const cardsHelp = {
    tab: "Each agent shows its tab's name, as in Herdr's own agents list.",
    activity: "Under the tab's name, what's happening: while the agent works, what it says it's doing; between replies, the name Claude Code gave the conversation.",
    haiku: "Under the tab's name, what's happening: while the agent works, what it says it's doing; between replies, Claude Haiku's title for what it's doing now (asked again after each reply, at most once a minute).",
  }[now.cards];
  return v_flex().w_full()
    .child(headingRow(t, "Titles"))
    .child(about(t, "Where the names of tabs and the titles in the agents list come from. Herdr's way unless you pick Claude Haiku, which writes them from the conversation on its own account (each one counts against that account's limits). Right-click a tab → Regenerate title asks for one at any time."))
    .child(status(m, t))
    .child(choice("tabs", "Tab names", tabsHelp))
    .child(choice("cards", "Agents list", cardsHelp));
}
