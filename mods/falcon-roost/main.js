// falcon-roost: the whole sidebar, one mod in its three blocks (props.part: "top", "foot", or the
// spaces list). The list: each machine (This computer first, then the others in their colors), its
// state and menu; under it its folders (colored, foldable; smart ones collect spaces by where they
// work) and its spaces: a colored avatar, the name, the repo line (repo · branch ↑↓), and how many of
// its agents work or need you. Worktrees sit under their checkout. A filter field on top.
//   Click a space: show it. Drag a space onto a folder: put it there; onto another space: move it
//   there (and into that space's folder); onto "Drop here": out of its folder. Right-click a space,
//   folder or machine: its menu. Keys: falcon-roost.next / .prev go down / up the list as shown.
//   The focused pane's border takes the shown space's color (settings.json colors.space_focus).
// Popups of this mod: props.spaceMenu, props.folderMenu (+ machine), props.machineMenu, props.folderDialog.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, machines, panes, agents, run, openOverlay, props, exec, theme, shared, setShared, watchFolder, window, nextCommand, appHome, readTextFile, writeTextFile } from "herdr";
import { machineColor, hereColor, setMachineLooks, PROFILE_SAVED, folderFor, assignColors, gitTail, nestWorktrees } from "./core.js";
import { topBar, footer, fitFooter, onRail } from "./chrome.js";
import { MACHINE_ASK, doMachineAsk } from "./machines.js";
import { DISCONNECTED, MACHINES_CHANGED, NEW, ASK_NEW, COLORS, keyOf, localId, foldersOf, migrate, loadFolders, persistFolders, changeFolders, newSpace, machineList, newFolderId } from "./store.js";
import { fill, initSpaceMenu, spaceMenu, folderMenu, initFolderDialog, folderDialog, initMachineMenu, machineMenu, machineMenuSize } from "./menus.js";

const HERDR = (name) => `mods/workspace-chrome/${name}.svg`;
const GIT_EVERY = 60000;   // a repo's line asked again this often (local repos are watched too)
const HOLD_MS = 1500;      // a new space waits this long for its git, so a worktree doesn't jump under its checkout
const placeOf = (s, ps) => { const tabs = new Set((s.tabs ?? []).map((x) => x.id)); return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || ""; };
const placeKey = (s, ps) => JSON.stringify([s.machine ?? null, placeOf(s, ps)]);

// Every copy, popups too: the machine colors this computer's profile picks, again after a Settings save.
function machineLooks(view, cx) {
  const load = (cx) => cx.spawn(async (cx) => {
    const name = (await readTextFile(`${appHome()}/machine`).catch(() => null))?.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name ?? "")) return;
    try { setMachineLooks(JSON.parse(await readTextFile(`${appHome()}/machines/${name}.json`))?.machines); cx.notify(); } catch { /* no profile colors */ }
  });
  load(cx);
  cx.timer.every(500, (cx) => { const at = shared(PROFILE_SAVED); if (at && at !== view.profileAt) { view.profileAt = at; load(cx); } });
}

export default class FalconRoost extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.part = p.part ?? "spaces";
    machineLooks(this, cx);
    if (p.spaceMenu) return initSpaceMenu(this, cx);
    if (p.folderMenu) return;
    if (p.machineMenu) return initMachineMenu(this, cx);
    if (p.folderDialog) return initFolderDialog(this);
    if (this.part === "foot") { cx.timer.every(300, () => fitFooter()); return; }
    if (this.part !== "spaces") return;
    migrate();
    this.git = {};            // place key -> { name, branch, ahead, behind, repo, linked } | null
    this.checkedAt = {};
    this.queue = new Set();
    this.watching = new Set();
    this.firstSeen = {};      // a new space -> when it appeared
    this.known = new Set(spaces().map((s) => s.id));
    this.list = [];           // hc's machines
    this.loaded = new Set();  // machines (keys) whose folders file was read
    this.machineBusy = new Map(); // name -> what its menu asked that's under way ("Reconnecting…")
    this.folded = new Set(JSON.parse(localStorage.getItem("folded-machines") ?? "[]"));
    this.drag = null;         // { id, machine, from } a space being dragged
    this.over = null;         // what it's over: { kind: "space" | "folder" | "out", id }
    this.filter = InputState.new({ placeholder: "Filter spaces" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    cx.timer.every(500, (cx) => {
      const at = shared(MACHINES_CHANGED);
      const settling = this.list.some((m) => m.state === "connecting") && Date.now() - (this.listedAt ?? 0) > 2000;
      if ((at && at !== this.changedAt) || settling) { this.changedAt = at; this.refreshMachines(cx); }
    });
    this.loadAll(cx);
    cx.timer.every(15000, (cx) => this.loadAll(cx));
    cx.timer.every(250, (cx) => this.tick(cx));
    cx.timer.every(400, (cx) => cx.spawn(async () => this.tint()));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = String(await nextCommand()).split(".").pop();
        if (command === "next" || command === "prev") this.step(command === "next" ? 1 : -1);
        cx.notify();
      }
    });
  }

  refreshMachines(cx) {
    if (this.listing) return;
    this.listing = true; this.listedAt = Date.now();
    cx.spawn(async (cx) => {
      const list = await machineList().finally(() => { this.listing = false; });
      if (!list) return;
      this.list = list; this.listedAt = Date.now();
      // Connected again (from a terminal the menu opened, say): it isn't "disconnected" any more.
      const away = shared(DISCONNECTED) ?? {};
      const back = Object.keys(away).filter((n) => list.some((m) => m.name === n));
      if (back.length) setShared(DISCONNECTED, Object.fromEntries(Object.entries(away).filter(([n]) => !back.includes(n))));
      cx.notify();
    });
  }

  loadAll(cx) {
    cx.spawn(async (cx) => {
      for (const m of this.reachable()) {
        try { await loadFolders(m); this.loaded.add(keyOf(m)); } catch { /* away: next time */ }
      }
      cx.notify();
    });
  }

  reachable() { return [null, ...this.list.filter((x) => x.state === "connected").map((x) => x.name)]; }

  // ----- every 250 ms: new spaces (placing them, holding them for their git), git lines due
  tick(cx) {
    const now = Date.now(), all = spaces(), ps = panes();
    for (const s of all) if (!this.known.has(s.id) && !this.firstSeen[s.id]) this.firstSeen[s.id] = now;
    this.known = new Set(all.map((s) => s.id));
    this.adopt(all);
    this.recolor(all);
    const mask = shared(MACHINE_ASK);
    if (mask && mask.at !== this.machineAskedAt) {
      this.machineAskedAt = mask.at; setShared(MACHINE_ASK, null);
      cx.spawn(async (cx) => { const done = doMachineAsk(mask, this.machineBusy); cx.notify(); await done; cx.notify(); });
    }
    const ask = shared(ASK_NEW);
    if (ask && ask.at !== this.askedAt) { this.askedAt = ask.at; setShared(ASK_NEW, null); newSpace(ask.machine, ask.folder); }
    // Folder changes (from popups too) go to their machine's file, once its file was read.
    persistFolders(new Set(this.reachable().map(keyOf).filter((k) => this.loaded.has(k))));
    for (const s of all) {
      const key = placeKey(s, ps);
      if (!(key in this.git) || now - (this.checkedAt[key] ?? 0) > GIT_EVERY && window()?.active !== false) this.queue.add(key);
    }
    if (this.queue.size && !this.checking) cx.spawn(async (cx) => { await this.checkGit(); cx.notify(); });
    if (Object.values(this.firstSeen).some((at) => now - at < HOLD_MS)) cx.notify();
  }

  // Each open space a color (the least used); kept for spaces of machines away. Not while a machine
  // is still reading its spaces (they'd look closed, and lose theirs).
  recolor(all) {
    if (!all.length || machines().some((m) => m.layout === "loading")) return;
    const live = new Set([null, ...this.list.filter((m) => m.state === "connected").map((m) => m.name)]);
    const ready = new Set(machines().filter((m) => m.layout === "ready").map((m) => m.name ?? null));
    const keep = Object.keys(shared(COLORS) ?? {}).filter((id) => {
      const m = id.includes("/") ? id.split("/")[0] : null;
      return m !== null && (!live.has(m) || !ready.has(m));
    });
    const recolored = assignColors(shared(COLORS) ?? {}, all.map((x) => x.id), keep);
    if (recolored) setShared(COLORS, recolored);
  }

  // A space started from a folder's +: the first one that appears (on that machine) goes in it.
  adopt(all) {
    const want = shared(NEW);
    if (!want) return;
    const made = all.find((s) => !want.before.includes(s.id) && (s.machine ?? null) === (want.machine ?? null));
    if (!made && Date.now() < want.until) return;
    setShared(NEW, null);
    if (made && want.folder) changeFolders(made.machine ?? null, (d) => (d.list.some((f) => f.id === want.folder) ? { ...d, of: { ...d.of, [localId(made)]: want.folder } } : d));
  }

  async checkGit() {
    this.checking = true;
    try {
      while (this.queue.size) {
        const key = [...this.queue][0];
        this.queue.delete(key);
        const [machine, place] = JSON.parse(key);
        this.checkedAt[key] = Date.now();
        if (!place) { this.git[key] = null; continue; }
        try {
          const st = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd: place, on: machine });
          if (st.code !== 0) { this.git[key] = null; continue; }
          const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: place, on: machine })).stdout.trim();
          const common = (await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: place, on: machine })).stdout.trim();
          const head = /^# branch\.head (.+)$/m.exec(st.stdout)?.[1] ?? null;
          const ab = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(st.stdout);
          const name = common.endsWith("/.git") ? common.slice(0, -5).split("/").pop() : common.split("/").pop().replace(/\.git$/, "");
          this.git[key] = { name, branch: head, ahead: Number(ab?.[1] ?? 0), behind: Number(ab?.[2] ?? 0), repo: `${machine ?? ""}:${common}`, linked: common !== `${top}/.git` };
          if (!machine) this.watch(common);
        } catch { if (!(key in this.git)) this.git[key] = null; /* gone or away: keep what was known, ask again later */ }
      }
    } finally { this.checking = false; }
  }

  // A local repo's .git folder is watched: a commit or checkout there updates its spaces' lines.
  watch(common) {
    if (this.watching.has(common)) return;
    this.watching.add(common);
    (async () => {
      try {
        for (;;) {
          await watchFolder(common);
          for (const [key, g] of Object.entries(this.git)) if (g?.repo === `:${common}`) this.queue.add(key);
        }
      } catch { this.watching.delete(common); }
    })();
  }

  // The focused pane's border in the shown space's color.
  async tint() {
    if (this.tinting) return;
    const s = spaces().find((x) => x.active);
    const color = s && (shared(COLORS) ?? {})[s.id];
    if (!color) return;
    const hex = fill(theme(), color);
    if (hex === this.tinted) return;
    this.tinting = true;
    try {
      const file = `${appHome()}/settings.json`;
      const text = await readTextFile(file);
      const data = JSON.parse(text ?? "{}");
      if (data.colors?.space_focus !== hex) await writeTextFile(file, `${JSON.stringify({ ...data, colors: { ...(data.colors ?? {}), space_focus: hex } }, null, 2)}\n`, text);
      this.tinted = hex;
    } catch { /* busy or stale: next time */ } finally { this.tinting = false; }
  }

  // next / prev: the shown order.
  step(by) {
    const order = this.shownOrder ?? [];
    if (!order.length) return;
    const at = order.indexOf(spaces().find((s) => s.active)?.id);
    const next = at < 0 ? (by > 0 ? 0 : order.length - 1) : (at + by + order.length) % order.length;
    run("space.select", { id: order[next] });
  }

  // ----- the list
  machineNames() {
    const away = Object.keys(shared(DISCONNECTED) ?? {});
    return [...new Set([...spaces().map((s) => s.machine).filter(Boolean), ...this.list.map((m) => m.name), ...away])].sort();
  }

  stateOf(name) {
    if (!name) return "connected";
    const m = this.list.find((x) => x.name === name);
    if (!m && (shared(DISCONNECTED) ?? {})[name]) return "disconnected";
    return m ? m.state : "asleep";
  }

  agentCounts() {
    const out = new Map();
    for (const a of agents()) {
      const c = out.get(a.space) ?? { working: 0, blocked: 0, done: 0 };
      if (a.status in c) c[a.status] += 1;
      out.set(a.space, c);
    }
    return out;
  }

  endDrag(cx) {
    const { drag, over } = this;
    this.drag = null; this.over = null;
    cx.notify();
    if (!drag || !over) return;
    const m = drag.machine;
    const all = spaces();
    const src = all.find((s) => s.id === drag.id);
    if (!src) return;
    const lid = localId(src);
    const data = foldersOf(m);
    const place = (folderId) => changeFolders(m, (d) => {
      const of = { ...d.of };
      if (folderId) of[lid] = folderId;
      else if (folderFor({ id: lid, place: placeOf(src, panes()) }, d.list, {})) of[lid] = ""; // the rules would put it back
      else delete of[lid];
      return { ...d, of };
    });
    if (over.kind === "folder" && data.list.some((f) => f.id === over.id)) place(over.id);
    else if (over.kind === "out") place(null);
    else if (over.kind === "space" && over.id !== drag.id) {
      const target = all.find((s) => s.id === over.id);
      if (!target || (target.machine ?? null) !== m) return;
      place(folderFor({ id: localId(target), place: placeOf(target, panes()) }, data.list, data.of));
      run("space.move", { id: drag.id, index: all.findIndex((s) => s.id === over.id) + 1 });
    }
  }

  spaceRow(t, s, ctx) {
    const { rail, counts, colors } = ctx;
    const g = this.git[placeKey(s, ctx.ps)] ?? null;
    const color = fill(t, colors[s.id] ?? "ansi6");
    const c = counts.get(s.id) ?? { working: 0, blocked: 0, done: 0 };
    const name = s.name || "space";
    const avatar = s.worktree
      ? svg(HERDR("git-branch")).size(13).flex_none().text_color(t.dim)
      : div().size(18).flex_none().rounded(5).bg(color).flex().items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child(([...name][0] ?? "?").toUpperCase());
    const dragging = this.drag && this.drag.id !== s.id && (this.drag.machine ?? null) === (s.machine ?? null);
    const target = this.over?.kind === "space" && this.over.id === s.id;
    const base = h_flex().id(`roost-sp-${s.id}`).flex_none().rounded(8).cursor_pointer().relative()
      .when(s.active, (el) => el.bg(t.selected)).when(!s.active, (el) => el.hover((x) => x.bg(t.hover)))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "falcon-roost", kind: "popup", width: 240, height: 260, props: { spaceMenu: s.id } }); });
    if (rail) {
      const badge = c.blocked ? t.blocked : c.done ? t.done : null;
      return base.h(30).justify_center().items_center().tooltip(name).on_click(() => run("space.select", { id: s.id })).child(avatar)
        .when(Boolean(badge), (el) => el.child(div().absolute().top(4).right(4).size(7).rounded(4).bg(badge).border(1.5).border_color(t.chrome)));
    }
    return base.h(s.worktree ? 28 : 30).pl(8 + (s.worktree ? 18 : 0)).pr(8).gap(9).items_center()
      .when(Boolean(this.drag?.id === s.id && this.over), (el) => el.opacity(0.5))
      .when(target, (el) => el.border_t_2().border_color(t.accent))
      .on_mouse_down("left", (_e, cx) => { if (!s.worktree) { this.drag = { id: s.id, machine: s.machine ?? null }; cx.notify(); } })
      .on_mouse_move((_e, cx) => { if (dragging && !target) { this.over = { kind: "space", id: s.id }; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => { if (this.drag?.id === s.id && !this.over) { this.drag = null; run("space.select", { id: s.id }); cx.notify(); } else this.endDrag(cx); })
      .child(avatar)
      .child(div().flex_none().max_w(150).truncate().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(11.5).text_color(t.dim).child(gitTail(g, name, s.worktree)))
      .when(c.working > 0, (el) => el.child(h_flex().flex_none().gap(2).items_center().text_size(10.5).text_color(t.working)
        .child(svg(HERDR("spinner")).size(10).spin(900)).when(c.working > 1, (x) => x.child(String(c.working)))))
      .when(c.blocked > 0, (el) => el.child(div().flex_none().px(5).h(15).rounded(8).bg(`${t.blocked}26`).text_size(10).font_bold().text_color(t.blocked).flex().items_center().child(String(c.blocked))));
  }

  folderHeader(t, f, machine, members, rail, counts) {
    const tone = f.color ? fill(t, f.color) : t.dim;
    const urgent = members.some((s) => (counts.get(s.id)?.blocked ?? 0) > 0);
    const hot = this.over?.kind === "folder" && this.over.id === f.id;
    const toggle = () => changeFolders(machine, (d) => ({ ...d, list: d.list.map((x) => (x.id === f.id ? { ...x, folded: !x.folded } : x)) }));
    const tile = div().size(18).flex_none().rounded(5).bg(tone).flex().items_center().justify_center().child(svg(HERDR("folder")).size(12).text_color("#ffffff"));
    const head = h_flex().id(`roost-f-${machine ?? ""}-${f.id}`).flex_none().rounded(8).cursor_pointer()
      .when(hot, (el) => el.bg(t.selected).border_1().border_color(t.accent)).when(!hot, (el) => el.hover((x) => x.bg(t.hover)))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "falcon-roost", kind: "popup", width: 220, height: 250, props: { folderMenu: f.id, machine } }); });
    if (rail) return head.h(30).justify_center().items_center().tooltip(f.name).on_click(() => toggle()).child(tile);
    return this.hoverable(head, `f:${machine ?? ""}:${f.id}`).h(30).pl(8).pr(8).gap(9).items_center()
      .on_mouse_move((_e, cx) => { if (this.drag && (this.drag.machine ?? null) === (machine ?? null) && !hot) { this.over = { kind: "folder", id: f.id }; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => { if (this.drag) this.endDrag(cx); else toggle(); })
      .child(tile)
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(f.name))
      .when(Boolean(f.folded) && urgent, (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.blocked)))
      .when(this.hot === `f:${machine ?? ""}:${f.id}`, (el) => el.child(div().id(`roost-f-new-${f.id}`).flex_none().px(4).rounded(4).text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_mouse_up("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); newSpace(machine, f.id); }).child(svg(HERDR("plus")).size(12))))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(String(members.length)))
      .child(svg(HERDR(`chevron-${f.folded ? "right" : "down"}`)).size(11).flex_none().text_color(t.dim));
  }

  machineHeader(t, name, rail, summary = null) {
    const state = this.stateOf(name);
    const color = (name ? machineColor(name) : hereColor()) ?? t.muted;
    const folded = this.folded.has(keyOf(name));
    const toggle = () => {
      const next = new Set(this.folded);
      next.has(keyOf(name)) ? next.delete(keyOf(name)) : next.add(keyOf(name));
      this.folded = next;
      localStorage.setItem("folded-machines", JSON.stringify([...next]));
    };
    const tool = (id, icon, tip, action) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .hover((x) => x.bg(t.selected).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); action(); }).child(svg(HERDR(icon)).size(13));
    const hot = this.hot === `m:${keyOf(name)}`;
    const head = h_flex().id(`roost-m-${keyOf(name)}`).h(30).flex_none().rounded(8).cursor_pointer().items_center()
      .hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => { toggle(); cx.notify(); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "falcon-roost", kind: "popup", ...machineMenuSize(name), props: { machineMenu: { name } } }); })
      .child(svg(HERDR(name ? "server" : "monitor")).size(13).flex_none().text_color(color));
    if (rail) return head.justify_center().tooltip(name ?? "This computer");
    const line = this.hoverable(head, `m:${keyOf(name)}`).px(8).gap(7).text_size(11.5).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(name || hereColor() ? color : t.foreground).child(name ?? "This computer"))
      .when(Boolean(name && this.machineBusy?.has(name)), (el) => el.child(div().flex_none().text_size(10.5).child(this.machineBusy.get(name))))
      .when(state !== "connected" && !(name && this.machineBusy?.has(name)), (el) => el.child(div().flex_none().text_size(10.5).child(state.replace(/_/g, " "))))
      .when(state === "connected" && hot, (el) => el
        .child(tool(`roost-m-folder-${keyOf(name)}`, "folder-plus", "New folder", () => openOverlay({ mod: "falcon-roost", kind: "dialog", width: 470, height: 400, props: { folderDialog: newFolderId(), machine: name, fresh: true } })))
        .child(tool(`roost-m-new-${keyOf(name)}`, "plus", "New space", () => newSpace(name, null))))
      .child(div().size(6).flex_none().rounded(3).bg(state === "connected" ? t.ansi2 : t.dim))
      .child(svg(HERDR(`chevron-${folded ? "right" : "down"}`)).size(11).flex_none());
    if (!summary) return line;
    return v_flex().flex_none().gap(2).child(line)
      .child(div().px(10).pb(4).text_size(11).text_color(t.dim).truncate().child(summary));
  }

  machineGroup(t, name, all, ctx, order) {
    const { rail, ps, counts, q, names } = ctx;
    const out = [];
    const mine = all.filter((s) => (s.machine ?? null) === name);
    const state = this.stateOf(name);
    const folded = this.folded.has(keyOf(name)) || state === "disconnected";
    const matches = (s) => !q || (s.name ?? "").toLowerCase().includes(q);
    if (q && !mine.some(matches)) return out;
    if (name || names.length) out.push(this.machineHeader(t, name, rail, folded ? this.summary(mine, counts) : null));
    if (folded) return out;
    const spaceRow = (s) => { order.push(s.id); return this.spaceRow(t, s, ctx); };
    if (!mine.length) {
      const loading = machines().find((m) => (m.name ?? null) === name)?.layout === "loading";
      if (!rail) out.push(div().id(`roost-empty-${keyOf(name)}`).h(24).flex_none().pl(10).flex().items_center().text_size(11.5).text_color(t.dim)
        .child(loading ? "Reading…" : "No spaces"));
      return out;
    }
    const data = foldersOf(name);
    const nested = nestWorktrees(mine.map((s) => { const g = this.git[placeKey(s, ps)]; return { ...s, repo: g?.repo ?? null, linked: Boolean(g?.linked) }; }));
    // A worktree goes in its checkout's folder.
    let lastFolder = null;
    const folderOfRow = new Map();
    for (const s of nested) {
      const at = s.worktree ? lastFolder : folderFor({ id: localId(s), place: placeOf(s, ps) }, data.list, data.of);
      if (!s.worktree) lastFolder = at;
      folderOfRow.set(s.id, at);
    }
    for (const fd of data.list) {
      const members = nested.filter((s) => folderOfRow.get(s.id) === fd.id && matches(s));
      if (q && !members.length) continue;
      out.push(this.folderHeader(t, fd, name, members, rail, counts));
      if (fd.folded && !q) continue;
      const inside = members.map((s) => spaceRow(s));
      // Its spaces hang from a guide line under the folder's tile.
      if (rail) out.push(...inside);
      else if (inside.length) out.push(v_flex().id(`roost-in-${keyOf(name)}-${fd.id}`).flex_none().ml(16).pl(2).gap(1).border_l_1().border_color(t.border).children(inside));
    }
    for (const s of nested.filter((x) => !folderOfRow.get(x.id) && matches(x))) out.push(spaceRow(s));
    return out;
  }

  // A folded machine's line: "3 spaces · 2 working · 1 needs you".
  summary(mine, counts) {
    const sum = (k) => mine.reduce((n, s) => n + (counts.get(s.id)?.[k] ?? 0), 0);
    const working = sum("working"), blocked = sum("blocked");
    return [`${mine.length} space${mine.length === 1 ? "" : "s"}`, working ? `${working} working` : null, blocked ? `${blocked} need${blocked === 1 ? "s" : ""} you` : null].filter(Boolean).join(" · ");
  }

  // Header tools show while the pointer is over it.
  hoverable(el, key) {
    return el.on_hover((h, cx) => { if (h) this.hot = key; else if (this.hot === key) this.hot = null; cx.notify(); });
  }

  render() {
    const t = theme();
    const lineColor = (name) => { const c = name ? machineColor(name) : hereColor(); return c ? `${c}55` : t.border; };
    const p = props() ?? {};
    if (p.spaceMenu) return spaceMenu(this, t);
    if (p.folderMenu) return folderMenu(this, t);
    if (p.machineMenu) return machineMenu(this, t);
    if (p.folderDialog) return folderDialog(this, t);
    if (this.part === "top") return topBar(t);
    if (this.part === "foot") return footer(t);
    const rail = onRail();
    const ps = panes();
    const now = Date.now();
    const all = spaces().filter((s) => !this.firstSeen[s.id] || now - this.firstSeen[s.id] >= HOLD_MS || placeKey(s, ps) in this.git);
    const colors = shared(COLORS) ?? {};
    const counts = this.agentCounts();
    const q = this.filter.value().trim().toLowerCase();
    const ctx = { rail, ps, counts, colors };
    const rows = [], order = [];
    const names = this.machineNames();
    for (const name of [null, ...names]) {
      const group = this.machineGroup(t, name, all, { ...ctx, q, names }, order);
      if (!group.length) continue;
      if (!names.length) { rows.push(group); continue; }
      // Open: a line in the machine's color down the left of what's its. On the rail: a box per machine.
      const [head, ...body] = group;
      if (rail) rows.push(v_flex().id(`roost-card-${keyOf(name)}`).flex_none().rounded(9).border_1().border_color(t.border).bg(t.background).p(2).gap(2).children(group));
      else rows.push(head, ...(body.length ? [v_flex().id(`roost-line-${keyOf(name)}`).flex_none().ml(3).pl(5).gap(1).border_l_1().border_color(lineColor(name)).children(body)] : []));
    }
    this.shownOrder = order;
    const dragOut = this.drag && !rail;
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(32).flex_none().px(rail ? 0 : 14).pr(rail ? 0 : 8).gap(4).items_center().when(rail, (el) => el.justify_center()).text_size(11.5).text_color(t.dim)
        .when(!rail, (el) => el.child(svg(HERDR("layers")).size(13).flex_none()).child(div().flex_1().font_semibold().child("Spaces"))
          .child(div().id("roost-new-folder").size(24).flex().items_center().justify_center().rounded(6).hover((x) => x.bg(t.hover).text_color(t.foreground))
            .tooltip("New folder").on_click(() => openOverlay({ mod: "falcon-roost", kind: "dialog", width: 470, height: 400, props: { folderDialog: newFolderId(), machine: null, fresh: true } }))
            .child(svg(HERDR("folder-plus")).size(14))))
        .child(div().id("roost-new-space").size(24).flex().items_center().justify_center().rounded(6).hover((x) => x.bg(t.hover).text_color(t.foreground))
          .tooltip("New space").on_click(() => newSpace(null, null)).child(svg(HERDR("plus")).size(14))))
      .when(!rail, (el) => el.child(h_flex().mx(8).mb(4).h(28).flex_none().px(8).gap(6).items_center().rounded(7).border_1().border_color(t.border).bg(t.background)
        .child(svg(HERDR("search")).size(11).flex_none().text_color(t.dim)).child(Input.new(this.filter).flex_1().text_size(12).text_color(t.foreground))))
      .child(v_flex().id("roost-list").flex_1().min_h(0).px(rail ? 6 : 8).pb(14).gap(rail ? 6 : names.length ? 4 : 1).overflow_y_scrollbar()
        .on_mouse_up("left", (_e, cx) => { if (this.drag) this.endDrag(cx); })
        .on_hover((h, cx) => { if (!h && this.drag) { this.drag = null; this.over = null; cx.notify(); } })
        .children(rows.flat())
        .when(Boolean(dragOut), (el) => el.child(div().id("roost-out").mt(6).h(34).flex_none().rounded(8).border_1().border_dashed()
          .border_color(this.over?.kind === "out" ? t.accent : t.border).text_color(this.over?.kind === "out" ? t.foreground : t.dim).text_size(12)
          .flex().items_center().justify_center()
          .on_mouse_move((_e, cx) => { if (this.over?.kind !== "out") { this.over = { kind: "out" }; cx.notify(); } })
          .on_mouse_up("left", (_e, cx) => this.endDrag(cx)).child("Drop here to take it out of its folder"))));
  }
}
