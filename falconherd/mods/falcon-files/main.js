// falcon-files: the side panel's files, for the focused pane's folder (here or on another machine).
// A tree (folders open in place, git changes colored, a filter field), and a file view: Markdown
// rendered (or its source; it follows the file as it changes; Browser and pop-out), other text read-
// only with colors. Each file or folder's menu (⋯ or right-click): copy its path, Send to ▸ another
// connected machine, or, on another machine, Copy to this computer. Copies are a tar stream through
// herdr-core (transferCommand), run by a shell here; a dialog asks where, and before replacing.
// Popups of this mod: props.rowMenu ({ path, dir, root, on }), props.transfer ({ from, to }).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, hc, readTextFile, watchFolder, theme, settings, window, openOverlay, closeOverlay, props, shared, home, notify, layout } from "herdr";
import { modShown, homeLabel, transferCommand, transferDefault, shellQuote, expandDest, transferOutcome } from "./core.js";
import { isMarkdown, formatted, sourceState } from "./markdown.js";

const MOD = "falcon-files";
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const MARK_COLOR = (t, m) => (m === "A" ? t.ansi2 : m === "D" || m === "U" ? t.ansi1 : t.ansi3);
const slash = (p) => String(p ?? "").replace(/\\/g, "/");
const isAbsolute = (p) => /^(\/|[A-Za-z]:[\\/])/.test(p);
const shell = () => (window()?.platform === "windows" ? "gitbash" : "sh");
const runHere = (cmd, timeout = 600000) => exec(shell(), ["-c", cmd], { timeout });

// Where the panel looks: the focused pane's folder, on its machine.
function where() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const whereKey = () => JSON.stringify(where());

// A folder's entries: { name, dir }, .git left out, at most 501 (to know there are more).
async function list(path, on) {
  const windowsList = async () => {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=[bool]$_.PSIsContainer } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Can't list this folder");
    const out = JSON.parse(r.stdout || "[]");
    return Array.isArray(out) ? out : [out];
  };
  if (!on && window()?.platform === "windows") return windowsList();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; b=${p##*/}; [ "$b" = .git ] && continue; [ -d "$p" ] && k=d || k=f; printf "%s\\0%s\\0" "$k" "$b"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "list", path], { on }); }
  catch (e) { if (on && String(e).includes("program not found")) return windowsList(); throw e; }
  if (r.code !== 0) throw new Error(r.stderr || "Can't list this folder");
  const f = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < f.length; i += 2) out.push({ name: f[i + 1], dir: f[i] === "d" });
  return out;
}

// Connected machines other than `on` (null: this computer), by name.
async function otherMachines(on) {
  const r = await hc(["machine", "ls", "--json"]).catch(() => null);
  let ms = [];
  try { ms = JSON.parse(r?.stdout ?? "{}").machines ?? []; } catch { ms = []; }
  const names = ms.filter((m) => !m.temporary && ["connected", "online"].includes(m.state)).map((m) => m.name);
  return [...(on ? [null] : []), ...names.filter((n) => n !== on)];
}

export default class FalconFiles extends View {
  init(_props, cx) {
    if (props()?.rowMenu) return this.initMenu(cx);
    if (props()?.transfer) return this.initTransfer(cx);
    this.saved = new Map();
    this.asked = shared("files.open")?.at;
    this.entries = new Map(); this.open = new Set(); this.loadingPaths = new Set(); this.marks = {};
    this.filter = InputState.new({ placeholder: "Filter" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.tick(cx));
    cx.timer.every(2000, (cx) => this.followFile(cx));
    cx.timer.every(1500, (cx) => { if (this.dirty) { this.dirty = false; if (this.shown()) this.refresh(cx); else this.stale = true; } });
  }

  // ----- the tree
  current(ctx) { return this.ctx === ctx && whereKey() === ctx.key; }
  shown() { return modShown(layout(), MOD); }

  tick(cx) {
    if (!this.shown()) { this.stale = true; return; }
    if (this.watched && !this.on && Date.now() - (this.tickedAt ?? 0) < 60000) return; // watched: a check a minute
    this.tickedAt = Date.now();
    this.refresh(cx);
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return; // another machine's folder can't be watched
    const r = slash(root);
    if (r === slash(home()) || /^([A-Za-z]:)?[/]?$/.test(r)) return; // a home or a drive: the 10 s check instead
    this.watched = root;
    const ctx = this.ctx;
    cx.spawn(async () => {
      try { while (this.ctx === ctx) { await watchFolder(root); if (this.current(ctx)) this.dirty = true; } }
      catch { if (this.ctx === ctx) this.watched = null; }
    });
  }

  async loadFolder(path, ctx) {
    const entries = await list(path ? `${ctx.cwd}/${path}` : ctx.cwd, ctx.on);
    if (!this.current(ctx) || (path && !this.open.has(path))) return;
    const used = [...this.entries].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    const room = Math.max(0, Math.min(PER_FOLDER, TOTAL - used));
    this.entries = new Map(this.entries).set(path, entries.slice(0, room).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = where(), key = whereKey();
    if (key !== this.ctx?.key) {
      if (this.ctx) this.saved.set(this.ctx.key, { open: this.open, file: this.file });
      const saved = this.saved.get(key);
      this.ctx = { key, cwd, on }; this.root = cwd; this.on = on;
      this.entries = new Map(); this.open = new Set(saved?.open); this.loadingPaths = new Set(); this.marks = {};
      this.show(null); this.watched = null; this.error = null; this.limited = false; this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const ctx = this.ctx;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.open]) { if (!this.current(ctx)) return; await this.loadFolder(path, ctx); }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // No writes under .git (an index lock would wake the folder watch again).
          const st = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (st?.code === 0) for (const e of st.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = e.slice(0, 2);
            marks[`${slash(top.stdout.trim())}/${e.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(ctx)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(ctx)) this.error = String(e); }
      finally { if (this.ctx === ctx) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.open.has(path)) {
      this.open = new Set([...this.open].filter((p) => p !== path && !p.startsWith(`${path}/`)));
      this.entries = new Map([...this.entries].filter(([p]) => p !== path && !p.startsWith(`${path}/`)));
    } else {
      this.open = new Set(this.open).add(path);
      if (!this.entries.has(path) && !this.loadingPaths.has(path)) {
        const ctx = this.ctx;
        this.loadingPaths = new Set(this.loadingPaths).add(path);
        cx.spawn(async (cx) => {
          try { await this.loadFolder(path, ctx); } catch (e) { if (this.current(ctx)) this.error = String(e); }
          finally { if (this.ctx === ctx) this.loadingPaths = new Set([...this.loadingPaths].filter((p) => p !== path)); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // ----- the file view
  full(path = this.file) { return isAbsolute(path) ? path : `${this.root}/${path}`; }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.md = null; this.mdSource = false;
    if (!path || !cx) return;
    const ctx = this.ctx, on = this.on, file = this.full(path);
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file, { on });
        if (this.file !== path || !this.current(ctx)) return;
        if (text === null) { this.fileError = "This file isn't there anymore"; return; }
        if (text.includes("\0")) { this.fileError = "A binary file: no text to show"; return; }
        if (isMarkdown(path)) { this.md = text; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value: text.length > 400000 ? `${text.slice(0, 400000)}\n… (cut here)` : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(ctx)) this.fileError = "Can't show this file (binary, too large or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // A shown Markdown file follows its changes (an agent writing a plan).
  followFile(cx) {
    const path = this.file, ctx = this.ctx, on = this.on;
    if (this.md == null || !path || this.following) return;
    this.following = true;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.full(path), { on }).catch(() => null);
        if (text === null || text === this.md || this.file !== path || !this.current(ctx)) return;
        this.md = text;
        if (this.code) { this.code.release(); this.code = sourceState(text); }
        cx.notify();
      } finally { this.following = false; }
    });
  }

  rowMenu(path, dir) {
    openOverlay({ mod: MOD, kind: "popup", width: 240, height: 230, props: { rowMenu: true, path: this.full(path), dir, root: this.root, on: this.on } });
  }

  // The visible rows: the tree, or (filtering) every loaded entry whose name matches.
  rows(t) {
    const q = this.filter.value().trim().toLowerCase();
    const out = [];
    const row = (path, entry, depth, flat) => {
      const open = this.open.has(path), mark = this.marks[`${slash(this.root)}/${path}`];
      out.push(h_flex().id(`ff-${path}`).h(28).flex_none().pl(8 + depth * 16).pr(6).gap(7).items_center().rounded(7).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_hover((h, cx) => { this.hot = h ? path : this.hot === path ? null : this.hot; cx.notify(); })
        .on_click((_e, cx) => (entry.dir && !flat ? this.toggle(path, cx) : entry.dir ? null : this.show(path, cx)))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.rowMenu(path, entry.dir); })
        .child(entry.dir && !flat ? svg(ICON(`chevron-${open ? "down" : "right"}`)).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(ICON(entry.dir ? "folder" : "file-text")).size(14).flex_none().text_color(mark ? MARK_COLOR(t, mark) : t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(mark ? MARK_COLOR(t, mark) : t.foreground).child(flat ? path : entry.name))
        .when(Boolean(mark), (el) => el.child(div().flex_none().text_size(11).font_semibold().text_color(MARK_COLOR(t, mark)).child(mark)))
        .when(this.hot === path, (el) => el.child(div().id(`ff-more-${path}`).flex_none().px(5).rounded(5).text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.rowMenu(path, entry.dir); }).child("⋯"))));
    };
    const walk = (prefix, depth) => {
      if (out.length >= TOTAL || depth > 40) return;
      for (const e of this.entries.get(prefix) ?? []) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (q) { if (e.name.toLowerCase().includes(q)) row(path, e, 0, true); }
        else row(path, e, depth, false);
        if (e.dir && this.open.has(path)) walk(path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }

  // ----- the row menu popup
  initMenu(cx) {
    this.machines = null;
    cx.spawn(async (cx) => { this.machines = await otherMachines(props().on ?? null); cx.notify(); });
  }

  menu(t) {
    const { path, dir, on, overlay } = props();
    const name = path.split(/[\\/]/).pop();
    const parent = path.slice(0, path.length - name.length - 1) || "/";
    const close = () => closeOverlay(overlay);
    const item = (id, icon, label, action, enabled = true) => h_flex().id(id).h(30).px(9).gap(9).items_center().rounded(6).flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)).on_click((_e, cx) => { close(); action(cx); }))
      .child(svg(icon).size(13).flex_none().text_color(t.muted)).child(div().flex_1().truncate().child(label));
    const send = (to) => openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 460, height: 250, props: { transfer: { from: { machine: on ?? null, dir: slash(parent), name, isDir: dir }, to } } });
    return v_flex().size_full().p(5).gap(1).bg(t.popover).text_size(12.5)
      .child(div().px(9).pt(3).pb(5).truncate().text_size(11).text_color(t.dim).child(name))
      .child(item("ff-copy-path", ICON("file-text"), "Copy path", (cx) => cx.write_to_clipboard(path)))
      .child(div().px(9).pt(6).pb(3).text_size(11).text_color(t.dim).child(on ? "Copy" : "Send to"))
      .children((this.machines ?? []).map((m) => item(`ff-send-${m ?? "here"}`, m ? ICON("server") : ICON("monitor"), m ? (on ? `To ${m}` : m) : "To this computer…", () => send(m))))
      .when(this.machines !== null && this.machines.length === 0, (el) => el.child(div().px(9).py(4).text_size(11.5).text_color(t.dim).child("No other machine connected")))
      .when(this.machines === null, (el) => el.child(div().px(9).py(4).text_size(11.5).text_color(t.dim).child("Looking for machines…")));
  }

  // ----- the transfer dialog
  initTransfer(cx) {
    const { from, to } = props().transfer;
    const dest = transferDefault({ to, fromFolder: from.dir, spaces: spaces(), home: slash(home()) });
    this.dest = InputState.new({ value: dest, placeholder: to ? "a folder there (relative: in its home)" : "a folder here" });
    this.size = null; this.busy = false; this.confirmReplace = false; this.problem = null;
    this.dest.on("change", (_e, cx) => { if (this.confirmReplace) { this.confirmReplace = false; this.problem = null; cx.notify(); } });
    cx.spawn(async (cx) => {
      const q = shellQuote(`${from.dir}/${from.name}`);
      const r = from.machine ? await exec("du", ["-sk", `${from.dir}/${from.name}`], { on: from.machine }).catch(() => null) : await runHere(`du -sk ${q}`, 20000).catch(() => null);
      const kb = Number((r?.stdout ?? "").trim().split(/\s+/)[0]);
      this.size = Number.isFinite(kb) ? kb * 1024 : -1;
      cx.notify();
    });
  }

  async exists(machine, path) {
    if (machine) return (await exec("test", ["-e", path], { on: machine }).catch(() => null))?.code === 0;
    return (await runHere(`test -e ${shellQuote(path)}`, 10000).catch(() => null))?.code === 0;
  }

  go(cx) {
    const { from, to } = props().transfer;
    const typed = this.dest.value().trim();
    if (!typed) { this.problem = "Give a folder"; cx.notify(); return; }
    const dir = expandDest(typed, to, slash(home()));
    this.busy = true; this.problem = null; cx.notify();
    cx.spawn(async (cx) => {
      if (!this.confirmReplace && await this.exists(to, `${dir}/${from.name}`)) {
        this.busy = false; this.confirmReplace = true;
        this.problem = `${from.name} is already there. Copy again to replace it.`;
        cx.notify();
        return;
      }
      let cmd;
      try { cmd = transferCommand({ from, to: { machine: to, dir }, windows: window()?.platform === "windows" }); }
      catch (e) { this.busy = false; this.problem = String(e.message ?? e); cx.notify(); return; }
      const r = await runHere(cmd).catch((e) => ({ code: 1, stderr: String(e) }));
      this.busy = false;
      const done = transferOutcome(r.code, r.stderr);
      if (done.ok) {
        notify({ title: `${from.name} copied to ${to ?? "this computer"}`, body: done.note ? `${dir}. ${done.note}` : dir, level: done.note ? "warning" : "success", timeout: done.note ? 7000 : 4000 });
        closeOverlay(props().overlay);
      } else {
        this.problem = `Couldn't copy it: ${(r.stderr || r.stdout || "").trim().slice(0, 200) || "it stopped"}`;
        cx.notify();
      }
    });
  }

  transfer(t) {
    const { from, to } = props().transfer;
    const mb = this.size > 0 ? this.size / 1048576 : null;
    const sizeText = this.size === null ? "measuring…" : this.size < 0 ? "size unknown" : mb < 1 ? `${Math.max(1, Math.round(this.size / 1024))} KB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
    const button = (id, label, primary, action, disabled = false) => div().id(id).px(14).py(6).rounded(7).border_1().text_size(13)
      .border_color(primary ? t.accent : t.border).bg(primary ? t.accent : t.raised).text_color(primary ? t.accent_foreground : t.foreground)
      .when(disabled, (el) => el.opacity(0.5)).when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.9)).on_click(action)).child(label);
    return v_flex().id("ff-transfer").size_full().p(20).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape" && !this.busy) { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(div().text_size(15).font_semibold().child(`${from.isDir ? "Folder" : "File"} ${from.name} → ${to ?? "this computer"}`))
      .child(div().text_size(12).text_color(t.dim).child(`From ${from.machine ?? "this computer"}: ${from.dir} · ${sizeText}${mb > 500 ? " (large: this takes a while)" : ""}`))
      .child(v_flex().gap(5).child(div().text_size(12).text_color(t.muted).child(`Into this folder ${to ? `on ${to}` : "here"}`))
        .child(Input.new(this.dest).w_full().h(32).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(13).font_family("JetBrains Mono")))
      .when(Boolean(this.problem), (el) => el.child(div().text_size(12).text_color(this.confirmReplace ? t.ansi3 : t.blocked).child(this.problem)))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(button("ff-cancel", "Cancel", false, () => closeOverlay(props().overlay), this.busy))
        .child(button("ff-go", this.busy ? "Copying…" : this.confirmReplace ? "Replace" : "Copy", true, (_e, cx) => this.go(cx), this.busy)));
  }

  render(cx) {
    const t = theme();
    if (props()?.rowMenu) return this.menu(t);
    if (props()?.transfer) return this.transfer(t);
    if (this.stale && this.shown()) { this.stale = false; this.refresh(cx); }
    if (whereKey() !== this.ctx?.key) this.refresh(cx);
    // A Markdown link clicked in a terminal (the status bar asks for it here).
    const asked = shared("files.open");
    if (asked && asked.at !== this.asked) {
      this.asked = asked.at;
      this.show(this.root && asked.file.startsWith(`${this.root}/`) ? asked.file.slice(this.root.length + 1) : asked.file, cx);
    }
    const isMd = this.md !== null && this.md !== undefined;
    const tool = (id, label, icon, tip, action) => h_flex().id(id).flex_none().px(6).h(24).gap(5).items_center().rounded(6).text_size(11.5).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).when(Boolean(tip), (el) => el.tooltip(tip)).on_click(action)
      .when(Boolean(icon), (el) => el.child(svg(icon).size(12))).when(Boolean(label), (el) => el.child(label));
    const rootName = this.root ? slash(this.root).split("/").pop() || this.root : "";
    return v_flex().id("falcon-files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().id("ff-root").flex_none().font_semibold().cursor_pointer().hover((s) => s.text_color(t.accent))
          .on_click((_e, cx) => { this.show(null); cx.notify(); }).child(this.file ? "← Files" : "Files"))
        .when(Boolean(this.on), (el) => el.child(h_flex().flex_none().gap(4).items_center().text_size(11).text_color(t.dim).child(svg(ICON("server")).size(11)).child(this.on)))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim)
          .child(this.file ? homeLabel(slash(this.full()), slash(home())) : rootName))
        .when(Boolean(this.file) && isMd, (el) => el
          .child(tool("ff-source", this.mdSource ? "Formatted" : "Source", null, null, (_e, cx) => {
            this.mdSource = !this.mdSource;
            if (this.mdSource && !this.code) this.code = sourceState(this.md);
            cx.notify();
          }))
          .when(!this.on, (x) => x.child(tool("ff-browser", "Browser", "mods/falcon-files/popout.svg", "The full rendering in the browser (select and copy there)",
            () => exec(`${home()}/.local/bin/herdr-md-browser`, [this.full()]).catch(() => notify({ title: "Couldn't open the browser view", level: "error" })))))
          .child(tool("ff-pop", null, "mods/falcon-files/popout.svg", "Open in a floating window",
            () => openOverlay({ kind: "window", key: `falcon-md:${this.full()}`, mod: "falcon-md", props: { file: this.full(), on: this.on } }))))
        .when(Boolean(this.file), (el) => el.child(tool("ff-file-menu", "⋯", null, null, () => this.rowMenu(this.file, false)))))
      .when(!this.file, (el) => el
        .child(h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b_1().border_color(t.border)
          .child(svg(ICON("search")).size(12).flex_none().text_color(t.dim))
          .child(Input.new(this.filter).flex_1().text_size(12.5).text_color(t.foreground)))
        .child(v_flex().id("ff-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows(t))
          .when(Boolean(this.error) || !this.entries.get("")?.length, (x) => x.child(div().p(8).text_size(12).text_color(t.dim)
            .child(this.error || (this.loading ? "Reading the folder…" : this.root ? "No files" : "No folder"))))
          .when(this.limited, (x) => x.child(div().p(8).text_size(11).text_color(t.dim).child("Showing up to 500 entries a folder, 5,000 in all")))))
      .when(Boolean(this.file) && isMd && !this.mdSource, (el) => el.child(formatted("ff-md", this.md, this.full(), (abs, cx) => {
        if (abs.startsWith(`${this.root}/`)) this.show(abs.slice(this.root.length + 1), cx);
        else openOverlay({ kind: "window", key: `falcon-md:${abs}`, mod: "falcon-md", props: { file: abs, on: this.on } });
      }, this.on)))
      .when(Boolean(this.file) && !(isMd && !this.mdSource), (el) => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child(this.fileError || "Reading the file…")));
  }
}
