// falcon-hood: a pane's header (the layout's pane "header": { "content": { "mod": "falcon-hood" } }).
// Left: what runs there (its account's glyph, or its program's icon), its name, folder and branch,
// and where it came from (fork of, side chat of, moved from). Right: the machine it's on, the
// conversation's chip (its account's color, its session name: a click copies it), context used,
// sub-agents, and its state. On hover, or while the pane has focus, a toolbar: the conversation's
// actions (Send to main, Continue on…, Side chat, Fork) and the pane's (split, zoom, close).
// Keys (keys.json): falcon-hood.side / .fork / .send act on the focused pane.
// Props from the app: { pane, terminal }. Popup of this mod: props.subagentsOf (a terminal).
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { panes, spaces, terminals, props, run, theme, home, hc, exec, notify, nextCommand, openOverlay, closeOverlay } from "herdr";
import { sessionAccount, buildCopyArgv, briefRequest, formatTokens, switchTargets, switchKind, MODEL_CHOICES, EFFORT_LEVELS, loginShell, localAddress, machineOf, splitModels, homeLabel, originOf, shortAgo } from "./core.js";
import { sessionOf, terminalAccount, readingsFor, parse, subagentsOf, openSubagent, readOn, platformOf, machineBadge, hasConversation, notifyEmpty } from "./session.js";

const OWN = (name) => `mods/falcon-hood/${name}.svg`;
const HERDR = (name) => `mods/workspace-chrome/${name}.svg`;
const wait = (ms) => exec("sleep", [String(ms / 1000)]).catch(() => null);

export default class FalconHood extends View {
  init(_props, cx) {
    if (props()?.subagentsOf) return this.initSubagents(cx);
    this.hovered = false;
    this.session = null;
    this.context = null;
    this.subs = { total: 0, running: 0 };
    this.copiedUntil = 0;
    this.brief = null; // a brief asked of this side chat: { at, state, told }
    this.width = Infinity;
    const SUBS_EVERY = 15000;
    const refresh = (cx) => {
      if (this.refreshing) return;
      this.refreshing = true;
      cx.spawn(async (cx) => {
        try {
          const me = this.me();
          const s = me?.program?.agent && props()?.terminal ? await sessionOf(props().terminal).catch(() => null) : null;
          this.session = s;
          this.context = s ? (await readingsFor(s).catch(() => null))?.context ?? null : null;
          if (!s) this.subs = { total: 0, running: 0 };
          else if (Date.now() - (this.subsAt ?? 0) > SUBS_EVERY) {
            const subs = await subagentsOf(s, { all: true }).catch(() => []);
            this.subs = { total: subs.length, running: subs.filter((x) => x.running).length };
            this.subsAt = Date.now();
          }
          if (s && this.brief) await this.followBrief(s);
          cx.notify();
        } finally { this.refreshing = false; }
      });
    };
    refresh(cx);
    cx.timer.every(5000, refresh);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (!this.me()?.focused || !this.session) continue;
        if (command === "side" || command === "fork") cx.spawn(async () => this.copy(command));
        if (command === "send") this.askBrief();
        cx.notify();
      }
    });
  }

  me() { return panes().find((p) => p.pane === props()?.pane); }

  // Its account: Claude's and Codex's by their session, another program's by the command it started with.
  account() {
    const me = this.me();
    return sessionAccount(this.session) ?? terminalAccount(me?.terminal, me?.program?.key);
  }

  // A side chat's main conversation, from its labels.
  main() {
    const l = this.session?.labels ?? {};
    return l["herdr.sidechat.of"] ? { terminal: l["herdr.sidechat.of"], name: l["herdr.copy.of.name"] ?? l["herdr.sidechat.of"] } : null;
  }

  // A copy of the conversation: a side chat (split beside it) or a fork (a new tab), labelled with where
  // it came from; the folder-trust question a new copy asks is answered, hooks are left to the person.
  async copy(kind) {
    const s = this.session, me = this.me();
    if (!s || !me) return;
    if (!(await hasConversation(s))) { notifyEmpty(); return; }
    const argv = [...loginShell(platformOf(s.machine)), ...buildCopyArgv({ tool: s.tool, account: s.account, sessionId: s.sessionId, mainArgv: s.argv, machine: s.machine })];
    let args;
    if (kind === "side") args = ["do", "pane.split", "--pane", me.pane, "--direction", "right", "--argv", JSON.stringify(argv)];
    else {
      const space = spaces().find((sp) => sp.tabs.some((x) => x.id === me.tab));
      const tab = space?.tabs.find((x) => x.id === me.tab);
      const base = tab && !/^(\d+|tb.*)$/.test(tab.name) ? tab.name : s.name ?? "conversation";
      args = ["do", "tab.new", "--space", space?.id ?? "", "--name", `${base.slice(0, 24)} fork`, "--argv", JSON.stringify(argv)];
    }
    const made = parse((await exec("herdr-app", args).catch(() => ({ stdout: "" }))).stdout);
    if (!made?.terminal) { notify({ title: kind === "side" ? "Side chat didn't start" : "Fork didn't start", level: "error" }); return; }
    const t = made.terminal;
    await hc(["label", t, `herdr.${kind === "side" ? "sidechat" : "fork"}.of=${s.terminal}`, `herdr.copy.of.name=${s.name ?? s.terminal}`]).catch(() => null);
    for (let i = 0; i < 10; i++) {
      await wait(2000);
      const screen = (await hc(["read", t, "--lines", "15"]).catch(() => null))?.stdout ?? "";
      if (/Yes, I trust this folder/.test(screen)) { await hc(["keys", t, "down", "enter"]).catch(() => null); continue; }
      if (/Trust and continue/.test(screen)) { await hc(["keys", t, "enter"]).catch(() => null); continue; }
      if (/Hooks need review/.test(screen)) { notify({ title: "The copy needs you", body: "Review its hooks in the new pane", level: "warning" }); return; }
    }
  }

  // A side chat writes a brief of what was agreed and herdr-brief delivers it to the main conversation.
  askBrief() {
    const main = this.main();
    if (!main) return;
    const s = this.session;
    // The brief file's stamp before asking: a new one is any other stamp (the other machine's clock
    // may differ from ours, so stamps aren't compared with our time).
    const brief = { at: Date.now(), before: undefined, state: "asked", told: false };
    this.brief = brief;
    readOn(`${s.cache}/briefs/${localAddress(s.terminal)}.json`, s.machine)
      .then((text) => { brief.before = parse(text)?.at ?? null; })
      .finally(() => hc(["send", s.terminal, briefRequest(main.name, localAddress(main.terminal))]).catch(() => null));
  }

  async followBrief(s) {
    if (this.brief.before === undefined) return; // still reading the stamp from before
    const d = parse(await readOn(`${s.cache}/briefs/${localAddress(s.terminal)}.json`, s.machine));
    if (!d || d.at === this.brief.before) return;
    this.brief = { ...this.brief, state: d.state };
    if (this.brief.told || d.state === "waiting") return;
    this.brief = { ...this.brief, told: true };
    const name = this.main()?.name ?? d.main;
    if (d.state === "sent") notify({ title: `Brief sent to ${name}`, level: "success", timeout: 3000 });
    if (d.state === "failed") notify({ title: "Brief not sent", body: d.error ?? "", level: "error" });
  }

  // "Continue on…": the status bar's account menu, for this pane's conversation.
  continueOn() {
    const s = this.session;
    const others = switchTargets(s.machine).filter((to) => switchKind(s, to) !== "same");
    const models = Math.max(0, ...others.map((to) => splitModels(MODEL_CHOICES[to.tool] ?? []).main.length));
    const rows = Math.max(others.length, models, EFFORT_LEVELS.length);
    openOverlay({ mod: "falcon-status", kind: "popup", width: 270, height: Math.min(520, 46 + 26 * rows), props: { menu: "switch", terminal: s.terminal, start: "accounts" } });
  }

  // ----- the sub-agents popup
  initSubagents(cx) {
    this.list = null;
    const load = (cx) => {
      if (this.loading) return;
      this.loading = true;
      cx.spawn(async (cx) => {
        try {
          const s = await sessionOf(props().subagentsOf).catch(() => null);
          this.list = s ? await subagentsOf(s, { all: true }).catch(() => []) : [];
          cx.notify();
        } finally { this.loading = false; }
      });
    };
    load(cx);
    cx.timer.every(3000, load);
  }

  subagents(t) {
    const list = this.list ?? [];
    const running = list.filter((x) => x.running).length;
    const row = (x) => h_flex().id(`hood-sub-${x.id}`).h(30).px(8).gap(8).flex_none().items_center().rounded(6).cursor_pointer()
      .text_color(x.running ? t.foreground : t.muted).hover((s) => s.bg(t.selected))
      .on_click((_e, cx) => { const overlay = props().overlay; cx.spawn(async () => { await openSubagent(x); closeOverlay(overlay); }); })
      .child(x.running ? svg(HERDR("spinner")).size(11).flex_none().text_color(t.working).spin(900) : svg(HERDR("check")).size(11).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().child(x.description || x.type))
      .child(div().flex_none().max_w(96).truncate().px(6).py(1).rounded(5).bg(t.raised).text_size(10.5).text_color(t.dim).child(x.type))
      .child(div().flex_none().w(34).text_right().text_size(11).text_color(t.dim).child(shortAgo(Date.now() - x.at)));
    return v_flex().size_full().p(6).gap(1).bg(t.popover).text_size(12).text_color(t.foreground)
      .child(h_flex().h(26).px(8).gap(6).items_center().text_size(11).font_semibold().text_color(t.dim)
        .child(`Sub-agents · ${list.length}`).when(running > 0, (el) => el.child(div().text_color(t.working).child(`${running} running`))))
      .when(Boolean(this.list) && !list.length, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("None in this conversation yet")))
      // An explicit height: a popup is as tall as its content.
      .child(v_flex().id("hood-subs").h(Math.min(340, 31 * list.length)).flex_none().overflow_y_scrollbar().gap(1).children(list.map(row)));
  }

  // ----- the header
  tool(t, id, icon, tip, action) {
    return div().id(id).flex_none().p(4).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(svg(icon).size(14));
  }

  chip(t, acc) {
    const name = this.session.name;
    const copied = Date.now() < this.copiedUntil;
    const width = Math.min(170, Math.ceil(Math.max(name.length, 6) * 6.7)); // mono: the chip never resizes
    return h_flex().id(`hood-chip-${props().pane}`).flex_none().h(20).px(7).gap(6).items_center().rounded(10)
      .border_1().border_color(`${acc.color}55`).bg(`${acc.color}1a`).cursor_pointer().font_family("JetBrains Mono").text_size(11)
      .tooltip("Copy the session name").on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        cx.write_to_clipboard(name);
        this.copiedUntil = Date.now() + 1500;
        cx.notify();
        cx.timer.after(1600, (cx) => cx.notify());
      })
      .when(this.width >= 460, (el) => el.child(div().text_color(acc.color).child(acc.label)))
      .child(div().w(width).flex_none().truncate().text_color(copied ? t.done : t.foreground).child(copied ? "copied" : name))
      .when(this.brief?.state === "waiting", (el) => el.child(div().text_color(t.dim).child("· brief waiting")));
  }

  meter(t) {
    const c = this.context;
    return h_flex().id(`hood-ctx-${props().pane}`).flex_none().gap(5).items_center().font_family("JetBrains Mono").text_size(10.5).text_color(t.dim)
      .tooltip(`Context: ${formatTokens(c.used)} of ${formatTokens(c.size)}`)
      .child(div().w(28).h(4).rounded(2).bg(t.border).child(div().h(4).rounded(2).bg(c.percent >= 80 ? t.blocked : t.muted).w(Math.min(1, c.percent / 100) * 28)))
      .child(formatTokens(c.used));
  }

  state(t, status) {
    if (status === "working") return svg(HERDR("spinner")).size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().flex_none().px(7).h(18).flex().items_center().rounded(9).bg(`${t.blocked}26`).text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you");
    if (status === "done") return svg(HERDR("check")).size(12).flex_none().text_color(t.done);
    return null;
  }

  render() {
    const t = theme();
    if (props()?.subagentsOf) return this.subagents(t);
    const me = this.me();
    if (!me) return div();
    const s = this.session;
    const acc = this.account();
    const pane = me.pane;
    // A Markdown viewer pane (the status bar opens one for a link): the file, and a Browser button.
    const argv = terminals().find((x) => x.address === me.terminal)?.argv ?? [];
    const md = argv.some((a) => a.endsWith("/herdr-md-glow")) ? argv.at(-1) : null;
    const name = md ? md.split("/").pop() : ((me.program?.agent || me.program?.shell) && me.program.name) || me.title || me.program?.name || "shell";
    const where = homeLabel(md ? md.slice(0, md.lastIndexOf("/")) : me.cwd, s?.home ?? home());
    const glyph = acc ? svg(acc.icon).size(15).flex_none().text_color(acc.color)
      : me.program?.icon ? (me.program.tint ? svg(me.program.icon).size(15).flex_none().text_color(t.dim) : image(me.program.icon).w(15).h(15).flex_none())
      : svg(HERDR("terminal")).size(15).flex_none().text_color(t.dim);
    const origin = originOf(s?.labels);
    const wide = this.width >= 540, roomy = this.width >= 660;
    const tools = this.hovered || me.focused;
    const state = this.state(t, me.status);
    const sep = () => div().w(1).h(14).mx(2).flex_none().bg(t.border);
    return h_flex().id(`hood-${pane}`).size_full().overflow_x_scroll().bg(t.background).border_b_1().border_color(t.border).text_size(12)
      .on_hover((h, cx) => { this.hovered = h; cx.notify(); })
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .on_click(() => run("pane.focus", { pane }))
      .child(h_flex().flex_none().min_w_full().h_full().px(10).gap(8).items_center()
        .child(glyph)
        .child(h_flex().flex_grow(1).flex_shrink_0().w(100).gap(8).items_center().overflow_hidden()
          .child(div().flex_shrink(0).min_w(0).max_w(260).truncate().font_semibold().text_color(t.foreground).child(name))
          .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(where))
          .when(wide && Boolean(me.branch) && !md, (el) => el.child(h_flex().flex_shrink(0).max_w(170).h(18).px(6).gap(4).items_center().rounded(5).bg(t.raised)
            .text_color(t.muted).child(svg(HERDR("git-branch")).size(11).flex_none()).child(div().truncate().font_family("JetBrains Mono").text_size(10.5).child(me.branch))))
          .when(wide && Boolean(origin), (el) => el.child(div().flex_shrink(0).max_w(220).truncate().text_size(11).text_color(acc?.color ?? t.dim).child(origin))))
        .when(Boolean(machineOf(me.terminal)), (el) => el.child(machineBadge(t, machineOf(me.terminal), { label: wide })))
        .when(Boolean(acc && s?.name), (el) => el.child(this.chip(t, acc)))
        .when(roomy && Boolean(this.context), (el) => el.child(this.meter(t)))
        .when(this.subs.total > 0, (el) => el.child(h_flex().id(`hood-subs-${pane}`).flex_none().h(20).px(5).gap(4).items_center().rounded(5).cursor_pointer()
          .text_size(11).text_color(this.subs.running ? t.working : t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "falcon-hood", kind: "popup", width: 390, height: 52 + Math.min(340, 31 * Math.max(1, this.subs.total)), props: { subagentsOf: s.terminal } }); })
          .child(svg(OWN("bot")).size(13).flex_none()).child(this.subs.running ? `${this.subs.running}/${this.subs.total}` : String(this.subs.total))))
        .when(Boolean(md), (el) => el.child(this.tool(t, `hood-md-${pane}`, OWN("popout"), "Open the full rendering in the browser",
          () => exec(`${home()}/.local/bin/herdr-md-browser`, [md]).catch(() => notify({ title: "Couldn't open the browser view", level: "error" })))))
        .when(Boolean(state), (el) => el.child(state))
        .when(tools && Boolean(s), (el) => el.child(sep())
          .when(Boolean(this.main()), (x) => x.child(this.tool(t, `hood-send-${pane}`, OWN("send"), "Send a brief to the main conversation (Ctrl+Shift+M)", () => this.askBrief())))
          .child(this.tool(t, `hood-move-${pane}`, OWN("move"), "Continue on another account", () => this.continueOn()))
          .child(this.tool(t, `hood-side-${pane}`, OWN("side"), "Side chat (Ctrl+Shift+S)", (cx) => cx.spawn(async () => this.copy("side"))))
          .child(this.tool(t, `hood-fork-${pane}`, OWN("fork"), "Fork (Ctrl+Shift+D)", (cx) => cx.spawn(async () => this.copy("fork")))))
        .when(tools, (el) => el.child(sep())
          .child(this.tool(t, `hood-right-${pane}`, OWN("split-right"), "Split right", () => run("pane.split", { direction: "right", pane })))
          .child(this.tool(t, `hood-down-${pane}`, OWN("split-down"), "Split down", () => run("pane.split", { direction: "down", pane })))
          .child(this.tool(t, `hood-zoom-${pane}`, OWN(me.zoomed ? "unzoom" : "zoom"), me.zoomed ? "Unzoom" : "Zoom", () => run("pane.zoom", { pane })))
          .child(this.tool(t, `hood-close-${pane}`, HERDR("x"), "Close the pane", () => run("pane.close", { pane })))));
  }
}
