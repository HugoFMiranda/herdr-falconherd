// falcon-perch: the bar above the panes. The active space's tabs (each with its account's glyph or
// its program's icon, its name, and what its agent is doing: working, needs you, done), a list of
// all of them, the ones away (settled or snoozed), the + launcher, the side panels the layout has,
// and the window buttons where the system draws none.
//   Click a tab: show it. Drag it onto another: move it there. Double-click: rename. Middle-click or
//   ×: close. Right-click: Herdr's tab menu. Wheel: previous / next tab.
//   Unnamed tabs get a short name from their conversation (claude-tabname), once.
// Popups of this mod: props.away (the settled and snoozed), props.all (every tab of the space).
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, run, shared, setShared, openOverlay, closeOverlay, props, theme, window, layout, settings, appHome, readTextFile, hc, exec } from "herdr";
import { accounts, sessionAccount, cleanTabName, shellTopic, SNOOZE_FOREVER, tabTitle, shortAgo, panelFor } from "./core.js";
import { sessionOf, terminalAccount, parse, loadAccounts, readOn, helper, machineBadge } from "./session.js";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const SNOOZED = "flock.snoozed"; // terminal -> until (the agents list, falcon-flock)
const PEEKING = "tabs.peeking";           // tab -> { closed? }: settled, open for a look
const PANELS = { files: ["Files", "files"], changes: ["Changes", "git-compare"], devices: ["Devices", "monitor"] };

const findNode = (node, id) => (node?.id === id ? node : (node?.children ?? []).map((c) => findNode(c, id)).find(Boolean) ?? null);
const tabsOf = (space) => space?.tabs ?? [];
const leadOf = (tab) => panes().find((p) => p.tab === tab.id && p.program?.agent) ?? null;
const programOf = (tab) => leadOf(tab)?.program ?? panes().find((p) => p.tab === tab.id)?.program ?? null;

// What a conversation is about, for its name: Claude's title, or Codex's first message.
async function topicOf(s) {
  if (s.tool === "claude") return parse(await readOn(`${s.cache}/claude/${s.sessionId}.json`, s.machine))?.title ?? null;
  const r = await exec("sh", ["-c", `grep -m1 '"user_message"' "$1"`, "sh", s.rollout], s.machine ? { on: s.machine } : {}).catch(() => null);
  const text = parse(r?.stdout?.trim())?.payload?.message;
  return typeof text === "string" ? text.replace(/<[^>]+>/g, " ").trim().slice(0, 300) || null : null;
}

// A tab's look: its account's glyph and color ("icon|color"), else null (its program's icon then).
async function lookOf(pane) {
  const known = ["claude", "codex"].includes(pane.program?.key) || window()?.platform === "windows";
  const a = (known ? sessionAccount(await sessionOf(pane.terminal).catch(() => null)) : null) ?? terminalAccount(pane.terminal, pane.program?.key);
  return a ? `${a.icon}|${a.color}` : null;
}

export default class FalconPerch extends View {
  init(_props, cx) {
    this.looks = new Map();   // terminal -> "icon|color" (empty in the popups: their rows show programs' icons)
    if (props()?.away || props()?.all) return;
    this.pressed = null;      // a tab being dragged
    this.memory = parse(localStorage.getItem("panels")) ?? {}; // space -> its side panel (null: closed)
    readTextFile(`${appHome()}/mods/insights/mod.json`).then((t) => { this.insights = Boolean(t); cx.notify(); }, () => {});
    const refresh = (cx) => { if (!this.refreshing) { this.refreshing = true; cx.spawn(async (cx) => { try { await this.refreshLooks(cx); } finally { this.refreshing = false; } }); } };
    this.refreshLooks = async (cx) => {
      const next = new Map();
      for (const p of panes().filter((x) => x.program?.agent && x.terminal)) {
        const look = await lookOf(p);
        if (look) next.set(p.terminal, look);
      }
      const key = (m) => [...m].sort().join();
      if (key(next) !== key(this.looks)) { this.looks = next; cx.notify(); }
      cx.spawn(async () => this.name()); // a name takes seconds: not waited for
    };
    refresh(cx);
    cx.timer.every(5000, refresh);
  }

  // Unnamed tabs: once per conversation (or plain terminal) a short name from what it's about, on its
  // own account and machine; never over a name someone gave it meanwhile.
  async name() {
    if (this.naming) return;
    this.naming = true;
    try {
      await loadAccounts();
      const done = new Set(parse(localStorage.getItem("named")) ?? []);
      for (const tab of spaces().flatMap((s) => s.tabs).filter((x) => !x.named)) {
        const lead = leadOf(tab);
        const first = panes().find((p) => p.tab === tab.id && p.terminal);
        let key = null, topic = null, account = null, machine = null;
        if (lead) {
          const s = await sessionOf(lead.terminal).catch(() => null);
          if (!s) continue;
          key = s.sessionId; account = s.account; machine = s.machine;
          if (done.has(key)) continue;
          topic = await topicOf(s);
        } else if (first) {
          key = `term:${first.terminal}`;
          if (done.has(key)) continue;
          topic = shellTopic(parse((await hc(["get", first.terminal]).catch(() => null))?.stdout ?? "")?.foreground, first.cwd);
        }
        if (!key || !topic) continue;
        done.add(key);
        localStorage.setItem("named", JSON.stringify([...done].slice(-200)));
        const claude = accounts(machine, "claude");
        const dir = (claude.find((a) => a.id === account) ?? claude[0])?.dir;
        if (!dir) continue;
        const r = await helper("claude-tabname", [dir, topic], machine, { timeout: 40000 }).catch(() => null);
        const name = r?.code === 0 ? cleanTabName(r.stdout) : null;
        const still = spaces().flatMap((s) => s.tabs).find((x) => x.id === tab.id);
        if (name && still && !still.named) run("tab.rename", { id: tab.id, name });
      }
    } finally { this.naming = false; }
  }

  // Each space remembers its side panel: switching to it shows its choice; changing it records it.
  remember(space, panels) {
    const panel = findNode(layout(), "panel"), stack = findNode(layout(), "panel-body");
    if (!space || !panel) return;
    const now = panel.hidden ? null : stack?.active ?? null;
    if (space.id !== this.spaceId) {
      const fresh = this.spaceId === undefined;
      this.spaceId = space.id;
      const want = fresh ? undefined : panelFor(this.memory, space.id, panels);
      if (want !== undefined && want !== now) {
        this.restoring = { want, until: Date.now() + 1000 };
        if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
        else run("layout.hide", { id: "panel" });
        return;
      }
    }
    if (this.restoring && this.restoring.want !== now && Date.now() < this.restoring.until) return; // still landing
    this.restoring = null;
    if (this.memory[space.id] === now) return;
    this.memory = { ...this.memory, [space.id]: now };
    localStorage.setItem("panels", JSON.stringify(this.memory));
  }

  // A tab's state mark: snoozed or open for a look (dim, a mark that keeps it as it is), and its
  // agent's status.
  awayState(tab) {
    const snoozedMap = shared(SNOOZED) ?? {};
    const snoozed = panes().filter((p) => p.tab === tab.id && snoozedMap[p.terminal]).map((p) => p.terminal);
    const look = (shared(PEEKING) ?? {})[tab.id];
    if (snoozed.length) return { kind: "snoozed", icon: "clock", tip: "Snoozed: it goes back when you leave it. Click to wake it",
      keep: () => setShared(SNOOZED, Object.fromEntries(Object.entries(snoozedMap).filter(([k]) => !snoozed.includes(k)))) };
    if (look) return { kind: "look", icon: look.closed ? "pin" : "archive",
      tip: look.closed ? "Reopened: it closes again when you leave it. Click to keep it open" : "Settled: it goes back when you leave it. Click to keep it out",
      keep: () => { const rest = { ...(shared(PEEKING) ?? {}) }; delete rest[tab.id]; setShared(PEEKING, rest); } };
    return null;
  }

  tabIcon(t, tab, dim) {
    const lead = leadOf(tab);
    const look = lead && this.looks.get(lead.terminal);
    const program = programOf(tab);
    const el = look ? svg(look.split("|")[0]).size(14).flex_none().text_color(look.split("|")[1])
      : program?.icon ? (program.tint ? svg(program.icon).size(14).flex_none().text_color(t.muted) : image(program.icon).w(14).h(14).flex_none())
      : svg(ICON("terminal")).size(14).flex_none().text_color(t.muted);
    return el.when(dim, (x) => x.opacity(0.4));
  }

  statusMark(t, tab) {
    if (tab.status === "working") return svg(ICON("spinner")).size(12).flex_none().text_color(t.working).spin(900);
    if (tab.status === "blocked") return div().size(7).flex_none().rounded(4).bg(t.blocked);
    if (tab.status === "done") return svg(ICON("check")).size(12).flex_none().text_color(t.done);
    return null;
  }

  tab(t, space, shown, tab, i) {
    const away = this.awayState(tab);
    const mark = this.statusMark(t, tab);
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex().id(`perch-${tab.id}`).h(30).pl(9).pr(tab.active ? 5 : 10).gap(7).flex_none().items_center().rounded(8).text_size(12.8)
      .bg(tab.active ? t.raised : t.chrome).border_1().border_color(tab.active ? t.border : t.chrome)
      .text_color(tab.active ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(this.pressed !== null && this.pressed !== i, (el) => el.border_color(t.border))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: tab.id }); })
      .on_mouse_up("left", () => {
        const from = this.pressed;
        this.pressed = null;
        if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: tabsOf(space).findIndex((x) => x.id === tab.id) + 1 });
        else run("tab.select", { id: tab.id });
      })
      .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); run("tab.close", { id: tab.id }); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: space.id } } }); })
      .child(this.tabIcon(t, tab, Boolean(away)))
      .child(div().max_w(180).truncate().child(tabTitle(tab, programOf(tab))))
      .when(Boolean(mark), (el) => el.child(mark))
      .when(Boolean(away), (el) => el.child(div().id(`perch-keep-${tab.id}`).flex_none().p(2).rounded(4).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); away.keep(); }).tooltip(away.tip).child(svg(ICON(away.icon)).size(12))))
      .when(tab.active, (el) => el.child(div().id(`perch-close-${tab.id}`).flex_none().p(3).rounded(5).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: tab.id }); }).child(svg(ICON("x")).size(11))));
  }

  // A popup's rows: a tab, what it is, and when.
  popupRow(t, tab, when, onClick) {
    return h_flex().id(`perch-row-${tab.id}`).h(30).px(8).gap(8).flex_none().items_center().rounded(6).cursor_pointer()
      .bg(tab.active ? t.selected : t.popover).hover((s) => s.bg(t.selected)).on_click(onClick)
      .child(this.tabIcon(t, tab, false)).child(div().flex_1().min_w(0).truncate().child(tabTitle(tab, programOf(tab))))
      .when(Boolean(this.statusMark(t, tab)), (el) => el.child(this.statusMark(t, tab)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(when ?? ""));
  }

  popup(t) {
    const { away, all, overlay } = props();
    const space = spaces().find((s) => s.id === (away ?? all));
    const close = () => closeOverlay(overlay);
    const box = (title, rows) => v_flex().size_full().p(5).gap(1).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(div().px(8).pt(3).pb(4).text_size(11).font_semibold().text_color(t.dim).child(title)).children(rows);
    if (all) {
      return box(`All tabs · ${tabsOf(space).length}`, tabsOf(space).map((tab) => this.popupRow(t, tab, tab.settled ? "away" : "", () => {
        close();
        if (tab.settled) setShared(PEEKING, { ...(shared(PEEKING) ?? {}), [tab.id]: true });
        run("tab.select", { id: tab.id });
      })));
    }
    const snoozedMap = shared(SNOOZED) ?? {};
    const pad = (n) => String(n).padStart(2, "0");
    return box("Settled and snoozed", tabsOf(space).filter((tab) => tab.settled).map((tab) => {
      const until = Math.max(0, ...panes().filter((p) => p.tab === tab.id).map((p) => snoozedMap[p.terminal] ?? 0));
      const d = new Date(until);
      const when = !until ? `${shortAgo(Date.now() - (tab.settled_at ?? Date.now()))} ago` : until >= SNOOZE_FOREVER ? "until woken" : `until ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return this.popupRow(t, tab, when, () => {
        close();
        // A look: it goes back once another tab is shown (the agents list puts it back).
        if (!until) setShared(PEEKING, { ...(shared(PEEKING) ?? {}), [tab.id]: true });
        run("tab.select", { id: tab.id });
      });
    }));
  }

  render() {
    const t = theme();
    if (props()?.away || props()?.all) return this.popup(t);
    const space = spaces().find((s) => s.active);
    const all = tabsOf(space);
    const shown = all.filter((tab) => !tab.settled || tab.active); // settled ones live in the agents list
    const awayCount = all.length - shown.length;
    const stack = findNode(layout(), "panel-body");
    const panels = (stack?.children ?? []).map((c) => c.id).filter(Boolean);
    this.remember(space, panels);
    const panelOpen = (() => { const p = findNode(layout(), "panel"); return p && !p.hidden ? stack?.active : null; })();
    const w = window();
    const sidebar = findNode(layout(), "sidebar");
    // macOS: room for the traffic lights when the sidebar is too narrow to hold them.
    const lights = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && layout()?.traffic_lights
      ? Math.max(10, (layout().traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0)) : 10;
    const stop = (_e, cx) => cx.stop_propagation();
    // Buttons that open a popup get no tooltip: it would sit over the popup.
    const chip = (id, icon, label, on, onClick, tip) => h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().rounded(7).text_size(12)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(onClick).when(Boolean(tip), (el) => el.tooltip(tip))
      .child(svg(icon).size(14).flex_none()).when(Boolean(label), (el) => el.child(label));
    const windowButton = (id, icon, action) => div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(() => run(action))
      .child(svg(ICON(icon)).size(14));
    return h_flex().size_full().min_w(0).pr(8).pl(lights).gap(4).items_center().bg(t.chrome).border_b_1().border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel((e) => {
        if (Math.abs(e.delta.y) < 1 || Date.now() - (this.wheelAt ?? 0) < 120) return;
        this.wheelAt = Date.now();
        run(e.delta.y > 0 ? "tab.prev" : "tab.next");
      })
      .when(Boolean(space?.machine), (el) => el.child(machineBadge(t, space.machine)))
      .child(h_flex().id("perch-tabs").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar()
        .children(shown.map((tab, i) => this.tab(t, space, shown, tab, i))))
      .when(all.length > 5, (el) => el.child(chip("perch-all", ICON("layers"), String(all.length), false,
        () => openOverlay({ mod: "falcon-perch", kind: "popup", width: 300, height: Math.min(420, 31 * all.length + 34), props: { all: space.id } }))))
      .when(awayCount > 0, (el) => el.child(chip("perch-away", ICON("archive"), `${awayCount} away`, false,
        () => openOverlay({ mod: "falcon-perch", kind: "popup", width: 300, height: Math.min(360, 31 * awayCount + 34), props: { away: space.id } }))))
      .child(chip("perch-new", ICON("plus"), "", false, () => openOverlay({ mod: "falcon-launch", kind: "popup", width: 280, height: 560 }), "Start something"))
      .child(div().w(6))
      .when(Boolean(this.insights), (el) => el.child(chip("perch-insights", "mods/insights/insights.svg", "Insights", false, () => {
        const tab = all.find((x) => panes().some((p) => p.tab === x.id && p.mod === "insights"));
        if (tab) run("tab.select", { id: tab.id }); else run("tab.new", { space: space?.id, name: "Insights", mod: "insights" });
      })))
      .children(panels.map((id) => {
        const [label, icon] = PANELS[id] ?? [id.charAt(0).toUpperCase() + id.slice(1), "square"];
        const on = panelOpen === id;
        return chip(`perch-panel-${id}`, ICON(icon), label, on, () => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        });
      }))
      .when(Boolean(w?.buttons), (el) => el.child(div().w(6))
        .child(windowButton("perch-min", "minus", "window.minimize"))
        .child(windowButton("perch-max", "square", "window.maximize"))
        .child(windowButton("perch-close", "x", "window.close")));
  }
}
