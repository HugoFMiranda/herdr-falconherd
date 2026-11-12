// falcon-flock: the agents list. Each agent is a card: its account's color on the edge, its space and
// account on top, what the conversation is about below, its state, and for how long. Sorted by what
// needs you (Needs you, Done, Working, Idle) or grouped by space; pinned ones first; Snoozed, Settled
// and Recently closed below, folded. Chips on top filter by account and by machine.
//   Hover a card: copy its session name, pin, settle, snooze (or wake). Click: show it. A closed
//   conversation: click reopens it for a look (closed again when left, unless written to).
//   Running Claude sub-agents and kept sub-agent terminals sit under their agent.
//   Started again after a crash or reboot, it resumes the conversations it was showing.
// On the narrow sidebar rail: one icon per agent, its state on the corner.
// Popups of this mod: props.sortMenu, props.snoozeMenu ({ terminal, tab }).
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, machines, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, hc, exec, notify } from "herdr";
import { sessionAccount, machineColor, machineOf, SECTION_LABELS, FOLDED_BY_DEFAULT, snoozeUntil, dueSnoozes, SNOOZE_FOREVER, staleSettled, resumeArgv, rememberClosed, lostConversations, isShell, loginShell, shortAgo, flockFacets, flockMatches } from "./core.js";
import { sessionOf, terminalAccount, parse, subagentsOf, openSubagent, readOn, platformOf, machineBadge, terminalFacts } from "./session.js";

// Shared with the tab bar and the status bar.
const SNOOZED = "flock.snoozed";  // terminal -> until (ms)
const PEEKING = "tabs.peeking";           // tab -> true (a settled one open for a look) | { closed: conversation }
const CLOSED = "flock.closed";            // the last ended conversations
const RESUMED = "flock.resumed";          // terminal -> created_ms of the one a resume was typed into
const OPEN = "flock.open";                // terminal -> the conversation in it, to resume after a crash
const OLD = { [SNOOZED]: "agents-session.snoozed", [CLOSED]: "agents-session.closed", [OPEN]: "agents-session.open" };
const SETTLED_CLOSE_MS = 24 * 3600000;    // a settled tab this old is closed (its conversation to Recently closed)
const SNOOZES = [["30m", "30 minutes"], ["1h", "1 hour"], ["3h", "3 hours"], ["tomorrow", "Tomorrow 9:00"], ["off", "Until I wake it"]];
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const SECTIONS = { 4: ["Needs you", "blocked", "alert"], 3: ["Done", "done", "herdr:circle-check"], 2: ["Working", "working", "pulse"], 1: ["Idle", null, "moon"] };
const SORTS = [{ id: "priority", label: "By what needs you", icon: "herdr:clock" }, { id: "grouped", label: "By space", icon: "herdr:layers" }];
const ICON = (name) => (name.startsWith("herdr:") ? `mods/workspace-chrome/${name.slice(6)}.svg` : `mods/falcon-flock/${name}.svg`);
// Space colors, as the sidebar paints them (shared "space.colors").
const TONES = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const findNode = (node, id) => (node?.id === id ? node : (node?.children ?? []).map((c) => findNode(c, id)).find(Boolean) ?? null);
const onRail = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const spaceTone = (t, space) => { const c = (shared("space.colors") ?? {})[space] ?? "ansi6"; return c.startsWith("#") ? c : TONES[c] ?? t[c]; };
// A sub-agent terminal's state as a row shows it: error is blocked, done is idle (its parent's done is the news).
const kidState = (k, listed) => { const s = listed.get(k.address) ?? k.status; return s === "error" ? "blocked" : s === "done" ? "idle" : s; };
const plain = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// The first agent pane of each tab (else its focused terminal, else its first).
function leads(list) {
  const out = new Map();
  for (const p of list) {
    if (!p.terminal) continue;
    const cur = out.get(p.tab);
    if (!cur || (!cur.program?.agent && (p.program?.agent || (!cur.focused && p.focused)))) out.set(p.tab, p);
  }
  return out;
}
// A tab's line: a name someone gave it, else the program's own title when it tells something.
function tabLine(tab, lead) {
  const program = lead?.program?.name;
  const live = plain(lead?.title);
  const telling = live && live !== program && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== lead?.program?.key;
  return (tab.name === program || !tab.named) && telling ? live : tab.name;
}

// The narrow rail and back, to the width it had.
function toggleRail() {
  const w = findNode(layout(), "sidebar")?.size?.px;
  if (!onRail()) setShared("sidebar.width", w);
  setShared("sidebar.collapsed", !onRail());
  run("layout.resize", { id: "sidebar", px: onRail() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// A machine whose terminals we can see now (this computer always): only then is a gone terminal gone.
const reachable = (machine) => !machine || machines().some((m) => m.name === machine && m.layout === "ready");

export default class FalconFlock extends View {
  init(_props, cx) {
    if (props()?.sortMenu || props()?.snoozeMenu) return;
    // Once: what the old agents list kept moves to these keys.
    for (const [key, old] of Object.entries(OLD)) if (shared(key) == null && shared(old) != null) setShared(key, shared(old));
    this.folded = new Set(parse(localStorage.getItem("folded")) ?? FOLDED_BY_DEFAULT.map((id) => `sec-${id}`));
    this.chosen = new Set(parse(localStorage.getItem("chips")) ?? []);
    this.sessions = new Map();   // terminal -> its session and account
    this.known = new Map();      // terminal -> the conversation to remember if it ends
    this.subagents = new Map();  // terminal -> its running Claude sub-agents
    this.subsFolded = new Set();
    this.changed = parse(localStorage.getItem("changed")) ?? {}; // terminal -> { s, at }: since when it's in its state
    this.copied = { address: null, until: 0 };
    cx.timer.every(30000, (cx) => cx.notify());
    const refresh = (cx) => {
      if (this.refreshing) return;
      this.refreshing = true;
      cx.spawn(async (cx) => {
        try {
          await this.refresh(cx);
          if (shared("flock.error")) setShared("flock.error", null);
        } catch (err) {
          // A reloaded build's cx throws on its next use: nothing went wrong then.
          if (!/reloaded|closed/i.test(String(err?.message ?? err))) setShared("flock.error", String(err?.stack ?? err).slice(0, 400));
        } finally { this.refreshing = false; }
      });
    };
    this.refresh = async (cx) => {
      const next = new Map();
      const live = agents();
      const cwd = new Map(panes().map((p) => [p.terminal, p.cwd]));
      for (const a of live) {
        const s = await sessionOf(a.address).catch(() => null);
        if (!s) continue;
        next.set(a.address, { ...s, look: sessionAccount(s) });
        if (s.tool === "claude") this.subagents.set(a.address, (await subagentsOf(s).catch(() => [])).filter((x) => x.running));
        const title = s.tool === "claude" ? parse(await readOn(`${s.cache}/claude/${s.sessionId}.json`, s.machine))?.title ?? null : null;
        this.known.set(a.address, { tool: s.tool, account: s.account, sessionId: s.sessionId, name: s.name ?? a.space_name ?? null, title,
          folder: cwd.get(a.address) ?? null, space: a.space, machine: s.machine, skip: s.argv.includes("--dangerously-skip-permissions") });
      }
      // A conversation whose terminal really ended goes to Recently closed.
      const listed = new Set(live.map((a) => a.address));
      for (const [address, k] of [...this.known]) {
        if (listed.has(address) || !reachable(machineOf(address))) continue;
        // Still running it, or the terminal is gone? Quit back to its shell (no agent reports there) is ended too.
        const facts = await hc(["get", address]).then((r) => (r?.code === 0 ? parse(r.stdout) : null), () => null);
        if (facts?.state === "live" && !(isShell(facts.foreground?.name) && !facts.status?.app)) continue;
        this.known.delete(address);
        setShared(CLOSED, rememberClosed(shared(CLOSED) ?? [], { ...k, at: Date.now() }));
      }
      if (this.lostChecked) setShared(OPEN, Object.fromEntries(this.known));
      this.wake();
      const key = (m) => [...m].map(([k, v]) => `${k}=${v.name}/${this.known.get(k)?.title}/${v.look?.id}/${v.look?.color}/${v.look?.icon}`).sort().join();
      const subKey = [...this.subagents].map(([k, v]) => `${k}:${v.map((x) => x.id).join(",")}`).join(";");
      const nextKey = key(next); // titles come from this.known, so the last key is kept, not recomputed
      if (nextKey !== this.sessionsKey || subKey !== this.subKey) { this.sessions = next; this.sessionsKey = nextKey; this.subKey = subKey; cx.notify(); }
    };
    refresh(cx);
    cx.timer.every(5000, refresh);
    // Lost terminals come back as shells a little after a start: then resume what ran in them.
    cx.timer.after(8000, (cx) => cx.spawn(async () => { await this.resumeLost(); this.lostChecked = true; }));
  }

  // Due snoozes wake their tab; a snoozed or looked-at tab shown meanwhile goes back once another is
  // shown; a reopened conversation you wrote to stays; old settled tabs close.
  wake() {
    const snoozed = { ...(shared(SNOOZED) ?? {}) };
    const byAddress = new Map(agents().map((a) => [a.address, a]));
    const allTabs = spaces().flatMap((s) => s.tabs);
    const settled = new Set(allTabs.filter((x) => x.settled).map((x) => x.id));
    const shown = focused()?.tab;
    let dirty = false;
    for (const address of dueSnoozes(snoozed, Date.now())) {
      const a = byAddress.get(address);
      if (a) run("tab.unsettle", { id: a.tab });
      delete snoozed[address]; dirty = true;
    }
    for (const address of Object.keys(snoozed)) {
      const a = byAddress.get(address);
      if (!a) { if (reachable(machineOf(address))) { delete snoozed[address]; dirty = true; } }
      else if (!settled.has(a.tab) && a.tab !== shown) run("tab.settle", { id: a.tab });
    }
    if (dirty) setShared(SNOOZED, snoozed);
    const peeking = shared(PEEKING) ?? {};
    const tabIds = new Set(allTabs.map((x) => x.id));
    const working = new Set(agents().filter((a) => a.status === "working" || a.status === "blocked").map((a) => a.tab));
    const kept = Object.keys(peeking).filter((id) => peeking[id]?.closed && working.has(id));
    const left = Object.keys(peeking).filter((id) => !kept.includes(id) && (id !== shown || !tabIds.has(id)));
    if (left.length || kept.length) {
      for (const id of left.filter((x) => tabIds.has(x))) {
        const c = peeking[id]?.closed;
        if (c) { run("tab.close", { id, confirmed: true }); setShared(CLOSED, rememberClosed(shared(CLOSED) ?? [], { ...c, at: Date.now() })); }
        else if (!settled.has(id)) run("tab.settle", { id });
      }
      const done = new Set([...left, ...kept]);
      setShared(PEEKING, Object.fromEntries(Object.entries(peeking).filter(([id]) => !done.has(id))));
    }
    if (this.lostChecked) for (const id of staleSettled(spaces(), panes(), snoozed, Date.now(), SETTLED_CLOSE_MS)) run("tab.close", { id, confirmed: true });
  }

  show(a) {
    if (!(shared(SNOOZED) ?? {})[a.address]) setShared(PEEKING, { ...(shared(PEEKING) ?? {}), [a.tab]: true });
    run("tab.unsettle", { id: a.tab });
    run("pane.focus", { pane: a.pane });
  }

  wakeUp(a) {
    const rest = { ...(shared(SNOOZED) ?? {}) };
    delete rest[a.address];
    setShared(SNOOZED, rest);
    run("tab.unsettle", { id: a.tab });
  }

  reopen(c) {
    const argv = [...loginShell(platformOf(c.machine)), ...resumeArgv({ tool: c.tool, account: c.account, sessionId: c.sessionId, skipPermissions: c.skip, machine: c.machine })];
    const name = (c.name ?? "conversation").slice(0, 24);
    const args = spaces().some((s) => s.id === c.space)
      ? ["do", "tab.new", "--space", c.space, "--name", name, "--argv", JSON.stringify(argv)]
      : ["do", "space.new", "--name", name, ...(c.machine ? ["--machine", c.machine] : []), ...(c.folder ? ["--folder", c.folder] : []), "--argv", JSON.stringify(argv)];
    exec("herdr-app", args).then((r) => {
      if (r?.code !== 0) throw new Error((r?.stderr ?? "").trim() || "herdr-app do failed");
      const tab = parse(r?.stdout ?? "")?.tab;
      if (tab) setShared(PEEKING, { ...(shared(PEEKING) ?? {}), [tab]: { closed: c } });
      setShared(CLOSED, (shared(CLOSED) ?? []).filter((x) => x.sessionId !== c.sessionId));
    }).catch((e) => notify({ title: "Couldn't reopen it", body: String(e?.message ?? e).slice(0, 200), level: "error" }));
  }

  async resumeLost() {
    const saved = shared(OPEN) ?? {};
    const facts = {};
    for (const address of Object.keys(saved)) {
      const r = await hc(["get", address]).catch(() => null);
      facts[address] = r?.code === 0 ? parse(r.stdout) : null;
    }
    // Never a terminal an agent is listed in, and each terminal (by when it was made) only once:
    // a reload of this mod mustn't type the resume again.
    const listed = new Set(agents().map((a) => a.address));
    const resumed = shared(RESUMED) ?? {};
    const lost = lostConversations(saved, facts)
      .filter(({ address }) => !listed.has(address) && resumed[address] !== facts[address]?.created_ms);
    if (lost.length) setShared(RESUMED, { ...resumed, ...Object.fromEntries(lost.map(({ address }) => [address, facts[address]?.created_ms ?? null])) });
    for (const { address, conversation: c } of lost) {
      await hc(["send", address, resumeArgv({ tool: c.tool, account: c.account, sessionId: c.sessionId, skipPermissions: c.skip, machine: c.machine }).join(" ")]).catch(() => null);
    }
    for (const [address, c] of Object.entries(saved)) if (!facts[address] && reachable(machineOf(address))) setShared(CLOSED, rememberClosed(shared(CLOSED) ?? [], { ...c, at: Date.now() }));
    if (lost.length) notify({ title: `Resumed ${lost.length} conversation${lost.length > 1 ? "s" : ""}`, body: lost.map((x) => x.conversation.title || x.conversation.name).join(", "), level: "info" });
  }

  // Since when each agent is in its state (done and idle count as one: looking turns done idle).
  stamp(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s !== s) { this.changed = { ...this.changed, [a.address]: { s, at: now } }; dirty = true; }
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    this.changed = Object.fromEntries(Object.entries(this.changed).filter(([k, c]) => listed.has(k) || now - c.at < 30 * 86400000));
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // A done agent you look at turns idle: it stays with Done until you leave it.
  rankOf(a) {
    const cur = agents().find((x) => x.focused);
    if (!cur || cur.address !== this.held?.address || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  // Kept sub-agent terminals of an agent, depth first, with their tree lines.
  tree(all, address, lead = []) {
    const kids = all.filter((k) => k.parent === address && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [{ t: k, lines: [...lead, last ? "└" : "├"] }, ...this.tree(all, k.address, [...lead, last ? "" : "│"])];
    });
  }

  lookOf(a) { return this.sessions.get(a.address)?.look ?? terminalAccount(a.address, a.program?.key); }

  pic(t, a, look, size) {
    if (look) return svg(look.icon).size(size).flex_none().text_color(look.color);
    const p = a.program;
    if (!p?.icon) return svg(ICON("herdr:terminal")).size(size).flex_none().text_color(t.dim);
    return p.tint ? svg(p.icon).size(size).flex_none().text_color(t.foreground) : image(p.icon).w(size).h(size).flex_none();
  }

  state(t, status, compact = false) {
    if (status === "working") return svg(ICON("herdr:spinner")).size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return compact
      ? div().size(15).flex_none().rounded(5).bg(`${t.blocked}26`).text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")
      : div().flex_none().px(7).h(18).rounded(9).bg(`${t.blocked}26`).text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (status === "done") return svg(ICON("herdr:check")).size(12).flex_none().text_color(t.done);
    return div().size(7).mx(3).flex_none().rounded(4).border_1().border_color(t.dim);
  }

  // ----- popups
  sortMenu(t) {
    const on = sortOf().id;
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Show agents"))
      .children(SORTS.map((s) => h_flex().id(`flock-sort-${s.id}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
        .hover((el) => el.bg(t.hover)).on_click(() => { setShared("agents.sort", s.id); closeOverlay(props().overlay); })
        .child(svg(ICON(s.icon)).size(14).flex_none().text_color(t.muted)).child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg(ICON("herdr:check")).size(14).flex_none()))));
  }

  snoozeMenu(t) {
    const { terminal, tab, overlay } = props();
    return v_flex().size_full().p(4).gap(1).bg(t.popover).text_size(12).text_color(t.foreground)
      .child(div().px(8).pt(3).pb(4).text_size(11).text_color(t.dim).child("Snooze until"))
      .children(SNOOZES.map(([id, label]) => h_flex().id(`flock-snz-${id}`).h(26).px(8).rounded(5).items_center().hover((s) => s.bg(t.selected))
        .on_click(() => { setShared(SNOOZED, { ...(shared(SNOOZED) ?? {}), [terminal]: snoozeUntil(id, new Date()) }); run("tab.settle", { id: tab }); closeOverlay(overlay); })
        .child(label)));
  }

  // ----- rows
  tool(t, id, icon, tip, action) {
    return div().id(id).flex_none().p(3).rounded(5).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click((_e, cx) => { cx.stop_propagation(); this.hovered = null; action(cx); cx.notify(); }).child(svg(ICON(icon)).size(13));
  }

  card(t, a, ctx) {
    const { now, snoozed, away, label, subs } = ctx;
    const s = this.sessions.get(a.address);
    const look = this.lookOf(a);
    const hot = this.hovered === a.address;
    const copied = this.copied.address === a.address && Date.now() < this.copied.until;
    const until = snoozed[a.address];
    const isAway = away(a);
    const machine = machineOf(a.address);
    const k = this.known.get(a.address);
    const project = a.space_name || label(a);
    const line = /^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a);
    const heading = k?.title || (line !== project ? line : null) || a.program?.name || project;
    const since = this.changed[a.address]?.at;
    const edge = look?.color ?? t.border;
    const running = (this.subagents.get(a.address) ?? []).length;
    const tools = h_flex().flex_none().gap(1).items_center()
      .when(Boolean(machine), (el) => el.child(machineBadge(t, machine, { label: false })))
      .when(running > 0, (el) => el.child(h_flex().id(`flock-subs-${a.address}`).flex_none().h(18).px(4).gap(3).items_center().rounded(5).cursor_pointer()
        .text_size(11).text_color(t.working).hover((x) => x.bg(t.hover)).tooltip(`${running} sub-agent${running === 1 ? "" : "s"} running`)
        .on_click((_e, cx) => { cx.stop_propagation(); this.subsFolded.has(a.address) ? this.subsFolded.delete(a.address) : this.subsFolded.add(a.address); cx.notify(); })
        .child(svg("mods/falcon-hood/bot.svg").size(11)).child(String(running))))
      .when(subs.length > 0, (el) => el.child(div().id(`flock-fold-${a.address}`).flex_none().p(2).rounded(4).cursor_pointer().text_color(t.dim)
        .hover((x) => x.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address); cx.notify(); })
        .child(svg(ICON(`herdr:chevron-${this.folded.has(a.address) ? "right" : "down"}`)).size(11))))
      .when(hot && Boolean(s?.name), (el) => el.child(this.tool(t, `flock-copy-${a.address}`, copied ? "herdr:check" : "copy", `Copy session name: ${s.name}`, (cx) => {
        cx.write_to_clipboard(s.name); this.copied = { address: a.address, until: Date.now() + 1500 }; cx.timer.after(1600, (cx) => cx.notify());
      })))
      .when(hot, (el) => el.child(this.tool(t, `flock-pin-${a.address}`, a.pinned ? "herdr:pin-off" : "herdr:pin", a.pinned ? "Unpin" : "Pin to the top", () => run("terminal.pin", { terminal: a.address, pinned: !a.pinned }))))
      .when(hot && Boolean(until), (el) => el.child(this.tool(t, `flock-wake-${a.address}`, "wake", "Wake it now", () => this.wakeUp(a))))
      .when(hot && !isAway, (el) => el.child(this.tool(t, `flock-settle-${a.address}`, "settle", "Settle: put it away", () => run("tab.settle", { id: a.tab })))
        .child(this.tool(t, `flock-snooze-${a.address}`, "snooze", "Snooze", () => openOverlay({ mod: "falcon-flock", kind: "popup", width: 180, height: 172, props: { snoozeMenu: true, terminal: a.address, tab: a.tab } }))))
      .when(!hot && Boolean(until), (el) => el.child(h_flex().flex_none().gap(3).items_center().text_size(11).text_color(t.dim)
        .child(svg(ICON("snooze")).size(11)).when(until < SNOOZE_FOREVER, (x) => x.child(hhmm(until)))))
      .when(!hot && !until && Boolean(since), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(shortAgo(now - since))));
    return h_flex().id(`flock-${a.address}`).flex_none().rounded(9).cursor_pointer().overflow_hidden()
      .when(a.focused, (el) => el.bg(t.selected)).when(!a.focused, (el) => el.hover((x) => x.bg(t.hover)))
      .on_hover((on, cx) => { if (on) this.hovered = a.address; else if (this.hovered === a.address) this.hovered = null; cx.notify(); })
      .on_click(() => (isAway ? this.show(a) : run("pane.focus", { pane: a.pane })))
      .child(div().w(3).h_full().flex_none().bg(edge))
      .child(v_flex().flex_1().min_w(0).px(9).py(7).gap(3)
        .child(h_flex().h(18).gap(7).items_center()
          .child(this.pic(t, a, look, 15))
          .child(div().min_w(0).flex_shrink(1).truncate().text_size(11.5).text_color(t.muted).child(hot && copied ? "copied" : project))
          .when(Boolean(look?.label), (el) => el.child(div().flex_none().text_size(10.5).text_color(look.color).child(look.label)))
          .child(div().flex_1()).child(tools))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(a.status === "idle" && !a.focused ? t.muted : t.foreground).child(heading))
          .child(this.state(t, a.status))));
  }

  // A running Claude sub-agent under its agent: click shows its task and latest output.
  subagentRow(t, x, now) {
    return h_flex().id(`flock-sa-${x.id}`).pl(30).pr(8).h(26).flex_none().gap(8).items_center().rounded(7).cursor_pointer()
      .text_size(12).text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(() => openSubagent(x).then((ok) => { if (!ok) notify({ title: "Couldn't open that sub-agent", level: "warning", timeout: 4000 }); }))
      .child(div().w(10).h(13).flex_none().border_l_1().border_b_1().border_color(t.border).mb(13))
      .child(svg(ICON("herdr:spinner")).size(11).flex_none().text_color(t.working).spin(900))
      .child(div().flex_1().min_w(0).truncate().child(x.description || x.type))
      .child(div().flex_none().max_w(72).truncate().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(x.type))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(shortAgo(now - x.at)));
  }

  // A kept sub-agent terminal, in its tree.
  kidRow(t, s, shown, compact) {
    const k = s.t;
    const on = k.address === shown;
    return h_flex().id(`flock-kid-${k.address}`).pl(30).pr(8).h(26).flex_none().items_center().rounded(8).text_size(12.5)
      .when(on, (el) => el.bg(t.raised)).hover((x) => x.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : run("terminal.peek", { terminal: k.address })))
      .children(s.lines.map((l) => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input)).when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6))))
      .child(div().mr(8).child(this.pic(t, k, null, 14)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.state(t, kidState(k, this.listed), compact));
  }

  closedRow(t, c, now) {
    const look = sessionAccount(c);
    return h_flex().id(`flock-closed-${c.sessionId}`).px(9).h(30).flex_none().rounded(8).items_center().gap(8).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Reopen it for a look (it closes again when you leave it, unless you write to it)").on_click(() => this.reopen(c))
      .when(Boolean(look), (el) => el.child(svg(look.icon).size(14).flex_none().text_color(look.color)))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().min_w(0).max_w(120).truncate().child(c.name ?? "conversation"))
        .when(Boolean(c.title), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`· ${c.title}`))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(shortAgo(now - c.at)));
  }

  header(t, g, byPriority) {
    const open = !this.folded.has(g.id);
    const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
    return h_flex().id(`flock-${g.id}`).px(8).pt(9).h(31).flex_none().gap(6).items_center().text_size(11).font_semibold().cursor_pointer()
      .text_color(t[g.status] ?? t.dim).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        open ? this.folded.add(g.id) : this.folded.delete(g.id);
        localStorage.setItem("folded", JSON.stringify([...this.folded].filter((id) => id.startsWith("sec-"))));
        cx.notify();
      })
      .when(Boolean(g.icon), (el) => el.child(svg(ICON(g.icon)).size(12).flex_none()))
      .when(Boolean(g.tone), (el) => el.child(div().size(8).flex_none().rounded(3).bg(g.tone)))
      .child(div().truncate().child(g.label.toUpperCase()))
      .child(div().text_color(t.dim).child(String(g.members.length)))
      .child(div().flex_1())
      .when(!open && !byPriority && Boolean(top) && top !== "idle", (el) => el.child(this.state(t, top, true)))
      .child(svg(ICON(`herdr:chevron-${open ? "down" : "right"}`)).size(11).flex_none().text_color(t.dim));
  }

  chips(t, facets) {
    const toggle = (key) => (_e, cx) => {
      const next = new Set(this.chosen);
      next.has(key) ? next.delete(key) : next.add(key);
      this.chosen = next;
      localStorage.setItem("chips", JSON.stringify([...next]));
      cx.notify();
    };
    return h_flex().px(12).pb(6).gap(5).flex_wrap().children(facets.map((f) => {
      const on = this.chosen.has(f.key);
      const color = f.color ?? (f.machine ? machineColor(f.machine) : t.muted);
      return h_flex().id(`flock-chip-${f.key}`).h(22).px(8).gap(5).items_center().rounded(11).cursor_pointer().text_size(11)
        .border_1().border_color(on ? color : t.border).bg(on ? `${color}22` : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground)).on_click(toggle(f.key))
        .child(f.key.startsWith("machine:") ? svg(ICON(f.machine ? "herdr:server" : "herdr:monitor")).size(11).text_color(color) : div().size(7).rounded(4).bg(color))
        .child(f.label).child(div().text_color(t.dim).child(String(f.count)));
    }));
  }

  render() {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    if (props()?.snoozeMenu) return this.snoozeMenu(t);
    const rail = onRail();
    const sort = sortOf();
    const byPriority = sort.id === "priority";
    const now = Date.now();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const shown = focused()?.agent;
    this.stamp(list, now);
    // A kept sub-agent with a pane is in agents() too: under its parent it gets no row of its own (unless pinned).
    const nested = new Set(rail ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rankOf(a), ...this.tree(all, a.address).map((s) => RANK[kidState(s.t, this.listed)] ?? 0))]));
    if (byPriority) list = [...list].sort((x, y) => urgency.get(y.address) - urgency.get(x.address) || (this.changed[y.address]?.at ?? 0) - (this.changed[x.address]?.at ?? 0) || y.seq - x.seq);
    // Filters: chips by account and machine (only kinds with more than one).
    const facets = flockFacets(list.map((a) => ({ account: this.lookOf(a), machine: machineOf(a.address) })));
    const live = new Set(facets.map((f) => f.key));
    const chosen = new Set([...this.chosen].filter((k) => live.has(k)));
    list = list.filter((a) => flockMatches({ account: this.lookOf(a), machine: machineOf(a.address) }, chosen));
    const snoozed = shared(SNOOZED) ?? {};
    const settledTabs = new Set(spaces().flatMap((s) => s.tabs).filter((x) => x.settled).map((x) => x.id));
    const away = (a) => Boolean(snoozed[a.address]) || settledTabs.has(a.tab);
    const snoozedList = list.filter((a) => snoozed[a.address]);
    const settledList = list.filter((a) => !snoozed[a.address] && settledTabs.has(a.tab));
    list = list.filter((a) => !away(a));
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));
    // A card's tab line: a name someone gave it or the agent's own title, a tab number only to tell two apart.
    const leadPanes = leads(panes());
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((x) => [x.id, x]));
    const perTab = new Map();
    for (const a of list) perTab.set(a.tab, (perTab.get(a.tab) ?? 0) + 1);
    const labels = new Map([...list, ...snoozedList, ...settledList].map((a) => {
      const tab = tabs.get(a.tab);
      const many = perTab.get(a.tab) > 1;
      return [a.address, tab ? tabLine(many ? { ...tab, named: false } : tab, many ? a : leadPanes.get(a.tab)) : a.title || a.program?.name || ""];
    }));
    const label = (a) => labels.get(a.address) ?? "";
    const ctx = (subs) => ({ now, snoozed, away, label, subs });
    const withKids = (a) => {
      const subs = rail ? [] : this.tree(all, a.address);
      const runningSubs = this.subsFolded.has(a.address) ? [] : (this.subagents.get(a.address) ?? []).map((x) => this.subagentRow(t, x, now));
      return [rail ? this.railItem(t, a, label) : this.card(t, a, ctx(subs)), ...runningSubs,
        ...(this.folded.has(a.address) ? [] : subs.map((s) => this.kidRow(t, s, shown, byPriority)))];
    };
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", icon: "herdr:pin", members: pinned }] : [];
    for (const a of rest) {
      const r = urgency.get(a.address) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push(byPriority ? { id, label: SECTIONS[r][0], status: SECTIONS[r][1], icon: SECTIONS[r][2], members: [a] }
        : { id, label: a.space_name || "", tone: spaceTone(t, a.space), members: [a] });
    }
    const closed = shared(CLOSED) ?? [];
    if (snoozedList.length) groups.push({ id: "sec-snoozed", label: SECTION_LABELS.snoozed, icon: "snooze", members: snoozedList });
    if (settledList.length) groups.push({ id: "sec-settled", label: SECTION_LABELS.settled, icon: "herdr:archive", members: settledList });
    if (closed.length && !chosen.size) groups.push({ id: "sec-closed", label: SECTION_LABELS.closed, icon: "history", members: closed, closed: true });
    const rows = rail ? list.flatMap(withKids)
      : groups.flatMap((g) => [this.header(t, g, byPriority), ...(this.folded.has(g.id) ? [] : g.closed ? g.members.map((c) => this.closedRow(t, c, now)) : g.members.flatMap(withKids))]);
    return v_flex().size_full().min_h(0).bg(t.chrome).border_t_1().border_color(t.border).text_size(13)
      .when(!rail, (el) => el
        .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().gap(6)
          .child(svg(ICON("flock")).size(13).flex_none().text_color(t.dim))
          .child(div().text_size(11.5).font_semibold().text_color(t.dim).child("Agents"))
          .when(list.length > 0, (x) => x.child(div().text_size(11).text_color(t.dim).child(String(list.length))))
          .child(div().flex_1())
          .child(div().id("flock-sort").p(2).rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => openOverlay({ mod: "falcon-flock", kind: "popup", width: 210, height: 140, props: { sortMenu: true } }))
            .child(svg(ICON(sort.icon)).size(14))))
        .when(facets.length > 0, (x) => x.child(this.chips(t, facets))))
      .when(!rail && list.length === 0 && !snoozedList.length && !settledList.length, (el) => el.child(div().px(16).py(4).text_size(12).text_color(t.dim)
        .child(chosen.size ? "No agents match these chips." : "No agents yet. They show up here once they report their state.")))
      .child(v_flex().id("flock-list").flex_1().min_h(0).px(rail ? 6 : 8).gap(rail ? 2 : 3).when(rail, (el) => el.pt(8)).overflow_y_scrollbar().children(rows))
      .when(rail, (el) => el.child(h_flex().h(28).items_center().justify_center()
        .child(div().id("flock-rail").text_size(13).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click(toggleRail).child("»"))));
  }

  // On the rail: the agent's icon, ringed in its space's color, its state on the corner.
  railItem(t, a, label) {
    const look = this.lookOf(a);
    const machine = machineOf(a.address);
    const badge = a.status === "working" ? svg(ICON("herdr:spinner")).size(9).text_color(t.working).spin(900)
      : a.status === "blocked" || a.status === "done" ? div().size(7).rounded(4).bg(t[a.status]).border(1.5).border_color(t.chrome) : null;
    return h_flex().relative().id(`flock-${a.address}`).h(30).flex_none().items_center().justify_center().rounded(8)
      .tooltip(`${this.known.get(a.address)?.title || label(a)} · ${a.space_name || label(a)}${machine ? ` · ${machine}` : ""}`)
      .when(a.focused, (el) => el.bg(t.selected)).when(!a.focused, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(h_flex().size(24).flex_none().rounded(7).border(1.5).border_color(spaceTone(t, a.space)).items_center().justify_center().child(this.pic(t, a, look, 14)))
      .when(Boolean(badge), (el) => el.child(div().absolute().top(1).right(2).child(badge)))
      .when(Boolean(machine), (el) => el.child(div().absolute().bottom(1).left(2).child(svg(ICON("herdr:server")).size(9).text_color(machineColor(machine)))));
  }
}
