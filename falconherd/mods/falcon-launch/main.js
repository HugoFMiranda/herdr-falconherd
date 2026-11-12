// falcon-launch: the tab bar's + as a launcher. A search field, focused when it opens: typing filters
// the agents (your + menu entries and Herdr's), Enter starts the chosen one, ↑/↓ choose, a lone digit
// 1–9 starts that one at once. In Settings' + menu order, without the hidden ones; entries on an
// account show its icon in its color. Below: a terminal, a new space, worktrees, and Settings' + menu.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, openOverlay, closeOverlay, props, keys, window, shared, setShared, appHome, readTextFile } from "herdr";
import { isPicture, settingsOverlay, menuHidden, menuOrder, inMenuOrder, launcherLooks, launchMatches, keyLabel, joinCommand } from "./core.js";

// Each machine's last agents, shown at once while knownAgents() asks again.
const SEEN = "falcon-launch.agents";
const ROW = 34;
const parse = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

// This computer's profile: what Settings' + menu hides, its order, its entries' account looks.
async function profileLooks() {
  const home = appHome();
  const name = (await readTextFile(`${home}/machine`).catch(() => null))?.trim();
  const data = /^[A-Za-z0-9_-]+$/.test(name ?? "") ? parse(await readTextFile(`${home}/machines/${name}.json`).catch(() => null)) : null;
  const base = parse(await readTextFile(`${home}/programs.base.json`).catch(() => null));
  return { hidden: new Set(menuHidden(data)), order: menuOrder(data), looks: launcherLooks(data, base) };
}

const shortcut = (action) => {
  const k = keys().find((b) => b.section === "global" && b.action === action);
  return k?.keys ? keyLabel(k.keys, window()?.platform) : "";
};

export default class FalconLaunch extends View {
  init(_props, cx) {
    this.space = spaces().find((s) => s.active) ?? null;
    const where = this.space?.machine ?? "";
    this.agents = shared(SEEN)?.[where] ?? [];
    this.hidden = new Set();
    this.order = [];
    this.looks = {};
    this.chosen = 0;
    this.query = InputState.new({ placeholder: "Start an agent…" });
    this.query.on("change", (_e, cx) => this.typed(cx));
    this.query.on("submit", () => this.start(this.matches()[this.chosen]));
    this.query.focus();
    cx.spawn(async (cx) => { Object.assign(this, await profileLooks()); cx.notify(); });
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: this.space?.machine ?? null });
        setShared(SEEN, { ...(shared(SEEN) ?? {}), [where]: this.agents });
      } catch { this.failed = true; }
      cx.notify();
    });
  }

  // Installed ones, in Settings' order, without the hidden; searching also finds the not installed.
  matches() {
    const visible = inMenuOrder(this.agents.filter((a) => !this.hidden.has(a.key)), this.order);
    const q = this.query.value();
    return launchMatches(q.trim() ? visible : visible.filter((a) => a.installed), q);
  }

  typed(cx) {
    const q = this.query.value().trim();
    this.chosen = 0;
    const list = this.matches();
    // A lone digit: start that one (as the numbers beside them say).
    if (/^[1-9]$/.test(q)) {
      const installed = inMenuOrder(this.agents.filter((a) => !this.hidden.has(a.key) && a.installed), this.order);
      const pick = installed[Number(q) - 1];
      if (pick) return this.start(pick);
    }
    if (this.chosen >= list.length) this.chosen = 0;
    cx.notify();
  }

  close() { closeOverlay(props().overlay); }

  start(agent) {
    if (!agent?.installed) return;
    this.close();
    run("tab.new", { name: agent.name, space: this.space?.id, argv: agent.run });
  }

  move(by, cx) {
    const n = this.matches().length;
    if (n) { this.chosen = (this.chosen + by + n) % n; cx.notify(); }
  }

  icon(t, a, size) {
    const look = this.looks[a.key];
    if (look) return (isPicture(look.icon) ? image(look.icon).w(size).h(size).flex_none() : svg(look.icon).size(size).flex_none().text_color(look.color));
    if (!a.icon) return div().size(size).flex_none();
    return a.tint ? svg(a.icon).size(size).flex_none().text_color(t.foreground) : image(a.icon).w(size).h(size).flex_none();
  }

  agentRow(t, a, i, number) {
    const on = i === this.chosen;
    return h_flex().id(`fl-${a.key}`).h(ROW).px(10).gap(10).items_center().rounded(8).flex_none()
      .bg(on ? t.selected : t.popover).when(a.installed, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)))
      .on_click(() => this.start(a))
      .child(div().when(!a.installed, (el) => el.opacity(0.4)).child(this.icon(t, a, 16)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(13).text_color(a.installed ? t.foreground : t.dim).child(a.name))
        .when(on, (el) => el.child(div().truncate().text_size(10.5).font_family("JetBrains Mono").text_color(t.dim).child(joinCommand(a.run)))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(!a.installed ? "not installed" : number ? String(number) : ""));
  }

  action(t, id, icon, label, hint, onClick, enabled = true) {
    return h_flex().id(id).h(30).px(10).gap(10).items_center().rounded(7).flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)).on_click(() => { this.close(); onClick(); }))
      .child(svg(icon).size(14).flex_none().text_color(t.muted)).child(div().flex_1().text_size(12.5).child(label))
      .child(div().text_size(11).text_color(t.dim).child(hint));
  }

  render() {
    const t = theme();
    const list = this.matches();
    const searching = Boolean(this.query.value().trim());
    const installed = inMenuOrder(this.agents.filter((a) => !this.hidden.has(a.key) && a.installed), this.order);
    const space = this.space;
    const folder = panes().find((p) => p.focused)?.cwd;
    const worktree = (action) => openOverlay({ mod: "worktree", kind: "dialog", width: action === "open" ? 560 : 440, height: action === "open" ? 480 : 260, props: { space: space?.id, folder, action } });
    const empty = this.failed ? "Couldn't check which agents are installed" : this.agents.length ? "Nothing matches" : "Checking installed agents…";
    // The popup takes the height it's drawn at: the search, the list (up to 9 rows, then it scrolls), the actions.
    const height = 12 + 36 + 9 + 5 * 30 + 6 * 4 + Math.min(9, Math.max(1, list.length)) * (ROW + 1);
    return v_flex().id("falcon-launch").w_full().h(height).bg(t.popover).p(6).gap(4)
      .on_key_down((e, cx) => {
        if (e.key === "down") { this.move(1, cx); cx.stop_propagation(); }
        else if (e.key === "up") { this.move(-1, cx); cx.stop_propagation(); }
        else if (e.key === "escape") { this.close(); cx.stop_propagation(); }
      })
      .child(h_flex().h(36).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.query).flex_1().text_size(13).text_color(t.foreground)))
      .child(v_flex().id("fl-list").flex_1().min_h(0).overflow_y_scrollbar().gap(1)
        .children(list.map((a, i) => this.agentRow(t, a, i, searching ? 0 : installed.indexOf(a) + 1 <= 9 ? installed.indexOf(a) + 1 : 0)))
        .when(list.length === 0, (el) => el.child(div().px(10).py(8).text_size(12).text_color(t.dim).child(empty))))
      .child(div().h(1).mx(4).my(2).bg(t.border))
      .child(this.action(t, "fl-terminal", "icons/shell.svg", "Terminal", shortcut("tab.new"), () => run("tab.new", { space: space?.id })))
      .child(this.action(t, "fl-space", "mods/workspace-chrome/plus.svg", "New space", shortcut("space.new"), () => run("space.new")))
      .child(this.action(t, "fl-worktree", "mods/workspace-chrome/branch.svg", "New worktree…", "", () => worktree("new"), Boolean(space)))
      .child(this.action(t, "fl-worktree-open", "mods/workspace-chrome/git-branch.svg", "Open worktree…", "", () => worktree("open"), Boolean(space)))
      .child(this.action(t, "fl-edit", "mods/workspace-chrome/settings.svg", "Edit this menu…", "",
        () => openOverlay(settingsOverlay("menu"))));
  }
}
