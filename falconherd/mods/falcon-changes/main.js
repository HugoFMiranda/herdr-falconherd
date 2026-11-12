// falcon-changes: the side panel's git changes, for the focused pane's folder (here or on another
// machine). The header: the branch (a click switches or creates one), ahead/behind, and fetch, pull,
// push, stash and unstash. Then two lists, Staged and Changes: a checkbox stages or unstages a file,
// its +/− counts, and a click opens its diff right under it. On hover: open it in Files, copy its
// path, discard (asked first). The lists show as a flat list (each file's folder dimmed beside it) or a
// folder tree (folders fold; fold all / unfold all), as last picked. At the bottom: the message,
// Commit (the staged ones, or everything when nothing is staged) and Commit & push.
// Popup of this mod: props.branchMenu ({ root, on, current }).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, setShared, run, props, openOverlay, closeOverlay, notify, layout } from "herdr";
import { modShown, changedFiles, numberDiff, changeTree } from "./core.js";

const MOD = "falcon-changes";
const OWN = (name) => `mods/falcon-changes/${name}.svg`;
const HERDR = (name) => `mods/workspace-chrome/${name}.svg`;
// Reads write nothing under .git (no index refresh, lock or fsmonitor cookie): the folder watch
// would see it, and each refresh would start the next.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MAX_FILES = 1000, MAX_LINES = 600;
const statusColor = (t, s) => (s === "A" ? t.ansi2 : s === "D" || s === "U" ? t.ansi1 : t.ansi3);
// The view picked last (list or tree), kept in this mod's storage.
const VIEW_KEY = "falcon-changes.view";
const savedView = () => { try { return localStorage.getItem(VIEW_KEY) === "tree"; } catch { return false; } };
const saveView = (tree) => { try { localStorage.setItem(VIEW_KEY, tree ? "tree" : "list"); } catch { /* not kept: still switches */ } };
const lineCount = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);

function where() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const whereKey = () => JSON.stringify(where());

export default class FalconChanges extends View {
  init(_props, cx) {
    if (props()?.branchMenu) return this.initBranches(cx);
    this.files = [];
    this.open = null;      // the file whose diff shows: { path, side, rows }
    this.hot = null;
    this.asking = null;    // a discard being asked about
    this.tree = savedView(); // a folder tree, else a flat list
    this.folded = new Set(); // folder ids ("<side>:<path>") shown shut
    this.message = InputState.new({ placeholder: "What changed" });
    this.message.on("change", (_e, cx) => cx.notify());
    this.message.on("submit", (_e, cx) => this.commit(cx, false));
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.tick(cx));
  }

  shown() { return modShown(layout(), MOD); }

  tick(cx) {
    if (!this.shown()) { this.stale = true; return; }
    if (this.watched && !this.on && Date.now() - (this.tickedAt ?? 0) < 60000) return; // watched: a check a minute
    this.tickedAt = Date.now();
    this.refresh(cx);
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const token = {};
    this.watchToken = token;
    cx.spawn(async (cx) => {
      try { while (this.watchToken === token) { await watchFolder(root); if (this.watchToken !== token) break; if (this.shown()) this.refresh(cx); else this.stale = true; } }
      catch { if (this.watchToken === token) { this.watched = null; this.watchToken = null; } }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = where(), ctx = whereKey();
    if (ctx !== this.ctx) {
      this.ctx = ctx; this.root = null; this.files = []; this.open = null; this.branch = null; this.asking = null;
      this.error = null; this.note = null; this.watched = null; this.watchToken = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (whereKey() !== ctx) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.branch = null; this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim();
        if (this.messageRoot !== undefined && this.messageRoot !== `${on ?? ""}:${root}`) this.message.set_value("");
        this.messageRoot = `${on ?? ""}:${root}`;
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const counts = async (args) => {
          const r = await git(["diff", ...args, "--numstat", "-z", "--no-renames"]);
          if (r.code !== 0) throw new Error(r.stderr);
          const out = {};
          for (const e of r.stdout.split("\0")) {
            const [a, d, ...rest] = e.split("\t");
            if (rest.length) out[rest.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
          }
          return out;
        };
        const entries = status.stdout.split("\0").filter(Boolean);
        const files = changedFiles(entries.slice(0, MAX_FILES), await counts(["--cached"]), await counts([]));
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const current = (await git(["branch", "--show-current"])).stdout.trim();
        const name = current || (head.code === 0 ? "HEAD" : null);
        const upstream = await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
        const [ahead, behind] = upstream.code === 0 ? upstream.stdout.trim().split(/\s+/).map(Number) : [null, null];
        const stashes = (await git(["stash", "list"])).stdout.split("\n").filter(Boolean).length;
        if (whereKey() !== ctx) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > MAX_FILES; this.error = null;
        this.branch = { name: name === "HEAD" ? "detached" : name, upstream: upstream.code === 0, ahead, behind, stashes };
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open.path && f.side === this.open.side)) this.open = null;
        else if (this.open) await this.loadDiff(this.open, ctx);
      } catch (e) { if (whereKey() === ctx) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async loadDiff(open, ctx) {
    const f = this.files.find((x) => x.path === open.path && x.side === open.side);
    if (!f) return;
    let lines;
    if (f.fresh) {
      const text = await readTextFile(`${this.root}/${f.path}`, { on: this.on }).catch(() => null);
      lines = text === null ? ["Can't show this file (binary, too large or unreadable)"]
        : text.includes("\0") ? ["A binary file: no text diff"]
        : [`@@ -0,0 +1,${lineCount(text)} @@`, ...text.slice(0, 200000).replace(/\n$/, "").split("\n").map((l) => `+${l}`)];
    } else {
      const r = await exec("git", [...READ, "--literal-pathspecs", "diff", ...(f.side === "staged" ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", f.path], { cwd: this.root, on: this.on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [f.binary ? "A binary file changed" : "No text diff"] : all.slice(first);
    }
    if (whereKey() !== ctx || this.open?.path !== open.path || this.open?.side !== open.side) return;
    const more = lines.length > MAX_LINES;
    this.open = { ...open, rows: numberDiff(lines.slice(0, MAX_LINES).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l))), more };
  }

  toggleDiff(f, cx) {
    const same = this.open?.path === f.path && this.open?.side === f.side;
    this.open = same ? null : { path: f.path, side: f.side, rows: null };
    if (this.open) {
      const ctx = this.ctx, open = this.open;
      cx.spawn(async (cx) => {
        try { await this.loadDiff(open, ctx); } catch (e) { if (this.open === open) this.open = { ...open, rows: numberDiff([`Can't show this diff: ${e}`]) }; }
        cx.notify();
      });
    }
    cx.notify();
  }

  // git commands one after another (these write: no READ flags), then a refresh.
  act(cx, label, steps, { timeout, done } = {}) {
    if (!this.root || this.busy || this.ctx !== whereKey()) return;
    const root = this.root, on = this.on, ctx = this.ctx;
    this.busy = label; this.note = null; this.asking = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of steps) {
          const r = await exec("git", args, { cwd: root, on, ...(timeout ? { timeout } : {}) });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-3).join(" "));
        }
        if (whereKey() === ctx) done?.();
      } catch (e) { if (whereKey() === ctx) this.note = `${label} failed: ${e.message ?? e}`; }
      finally { this.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  setStaged(cx, f, staged) {
    const L = "--literal-pathspecs";
    if (staged) this.act(cx, "Stage", [[L, "add", "--", f.path]]);
    else this.act(cx, "Unstage", [this.hasHead ? [L, "restore", "--staged", "--", f.path] : [L, "rm", "--cached", "-q", "--", f.path]]);
  }

  setAll(cx, staged) {
    if (staged) this.act(cx, "Stage", [["add", "-A"]]);
    else this.act(cx, "Unstage", [this.hasHead ? ["restore", "--staged", "--", "."] : ["rm", "-r", "--cached", "-q", "--", "."]]);
  }

  // Back to the staged copy, or the last commit; a new file is deleted.
  discard(cx, f) { this.act(cx, "Discard", [f.fresh ? ["--literal-pathspecs", "clean", "-f", "-q", "--", f.path] : ["--literal-pathspecs", "restore", "--", f.path]]); }

  commit(cx, push) {
    const message = this.message.value().trim();
    if (!message || !this.root || this.busy || this.loading || this.ctx !== whereKey()) return;
    const staged = this.files.some((f) => f.side === "staged");
    const b = this.branch;
    const pushStep = push ? [b?.upstream ? ["push"] : ["push", "-u", "origin", "HEAD"]] : [];
    this.act(cx, push ? "Commit & push" : "Commit", [...(staged ? [] : [["add", "-A"]]), ["commit", "-m", message], ...pushStep],
      { timeout: push ? 120000 : undefined, done: () => this.message.set_value("") });
  }

  openInFiles(f) {
    setShared("files.open", { file: `${this.root}/${f.path}`, at: Date.now() });
    run("layout.select", { stack: "panel-body", child: "files" });
  }

  // ----- rows
  tool(t, id, icon, tip, action, color = null) {
    return div().id(id).flex_none().p(3).rounded(5).text_color(color ?? t.muted).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(svg(icon).size(13));
  }

  checkbox(t, id, on, tip, action) {
    return div().id(id).size(15).flex_none().rounded(4).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
      .flex().items_center().justify_center().cursor_pointer().tooltip(tip).hover((s) => s.border_color(t.accent))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .when(on, (el) => el.child(svg(HERDR("check")).size(11).text_color(t.accent_foreground)));
  }

  diffLine(t, { kind, number, text }) {
    if (kind === "@") return div().w_full().px(10).h(19).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(19).flex_none().gap(8)
      .when(kind === "+", (e) => e.bg(`${t.ansi2}18`)).when(kind === "-", (e) => e.bg(`${t.ansi1}18`))
      .child(div().w(32).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === " " ? "" : kind))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // depth: its place in the tree (null: the flat list, with its folder dimmed beside the name).
  fileRow(t, f, depth = null) {
    const id = `${f.side}:${f.path}`;
    const parts = f.path.split("/"), name = parts.pop();
    const open = this.open?.path === f.path && this.open?.side === f.side;
    const hot = this.hot === id;
    if (this.asking === id) {
      return h_flex().id(`fc-${id}`).h(30).flex_none().px(8).gap(6).items_center().rounded(7).bg(`${t.blocked}1f`)
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(f.fresh ? `Delete ${name}?` : `Throw away the changes to ${name}?`))
        .child(div().id(`fc-yes-${id}`).px(9).h(22).flex().items_center().rounded(6).bg(t.blocked).text_color(t.background).text_size(11.5).cursor_pointer()
          .on_click((_e, cx) => { cx.stop_propagation(); this.discard(cx, f); }).child(f.fresh ? "Delete" : "Discard"))
        .child(div().id(`fc-no-${id}`).px(9).h(22).flex().items_center().rounded(6).border_1().border_color(t.input).text_size(11.5).cursor_pointer()
          .on_click((_e, cx) => { cx.stop_propagation(); this.asking = null; cx.notify(); }).child("Keep"));
    }
    const row = h_flex().id(`fc-${id}`).h(30).flex_none().pl(depth === null ? 8 : 8 + depth * 16).pr(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(open, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => { const next = h ? id : this.hot === id ? null : this.hot; if (next !== this.hot) { this.hot = next; cx.notify(); } })
      .on_click((_e, cx) => this.toggleDiff(f, cx))
      .child(this.checkbox(t, `fc-check-${id}`, f.side === "staged", f.side === "staged" ? "Unstage" : "Stage", (cx) => this.setStaged(cx, f, f.side !== "staged")))
      .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(statusColor(t, f.status)).child(f.status))
      .child(h_flex().flex_1().min_w(0).gap(0)
        .child(div().min_w(0).flex_shrink(0).max_w(240).truncate().child(name))
        .when(depth === null && parts.length > 0, (e) => e.child(div().ml(6).min_w(0).flex_shrink(1).truncate().text_size(11.5).text_color(t.dim).child(parts.join("/")))))
      .when(hot, (e) => e
        .child(this.tool(t, `fc-open-${id}`, HERDR("file-text"), "Open in Files", () => this.openInFiles(f)))
        .child(this.tool(t, `fc-copy-${id}`, OWN("copy"), "Copy path", (cx) => cx.write_to_clipboard(f.path)))
        .when(f.side === "changes", (x) => x.child(this.tool(t, `fc-discard-${id}`, OWN("discard"), f.fresh ? "Delete this new file" : "Discard the changes", (cx) => { this.asking = id; cx.notify(); }))))
      .when(!hot && f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(!hot && f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
    if (!open) return [row];
    const rows = this.open.rows;
    return [row, v_flex().id(`fc-diff-${id}`).mx(4).mb(6).py(4).rounded(7).border_1().border_color(t.border).bg(t.background)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(11).overflow_hidden()
      .when(!rows, (e) => e.child(div().px(10).py(4).text_color(t.dim).child("Reading the diff…")))
      .children((rows ?? []).map((r) => this.diffLine(t, r)))
      .when(Boolean(this.open.more), (e) => e.child(div().px(10).pt(4).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_LINES} lines`)))];
  }

  dirRow(t, r) {
    const shut = this.folded.has(r.id);
    return h_flex().id(`fc-dir-${r.id}`).h(26).flex_none().pl(8 + r.depth * 16).pr(8).gap(6).items_center().rounded(7).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { const next = new Set(this.folded); shut ? next.delete(r.id) : next.add(r.id); this.folded = next; cx.notify(); })
      .child(svg(HERDR(shut ? "chevron-right" : "chevron-down")).size(11).flex_none().text_color(t.dim))
      .child(svg(HERDR("folder")).size(13).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(r.name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(String(r.count)));
  }

  // A section's rows: a flat list, or its folder tree.
  sectionRows(t, side, files) {
    if (!this.tree) return files.flatMap((f) => this.fileRow(t, f));
    return changeTree(files, side, this.folded).flatMap((r) => (r.kind === "dir" ? [this.dirRow(t, r)] : this.fileRow(t, r.file, r.depth)));
  }

  // ----- the branch switcher popup
  initBranches(cx) {
    const { root, on } = props().branchMenu;
    this.menu = { local: [], remote: [], at: 0, busy: false };
    this.filter = InputState.new({ placeholder: "Switch to, or create, a branch" });
    this.filter.on("change", (_e, cx) => { this.menu = { ...this.menu, at: 0 }; cx.notify(); });
    this.filter.on("submit", (_e, cx) => this.pickBranch(this.choices()[this.menu.at], cx));
    this.filter.focus();
    cx.spawn(async (cx) => {
      const r = await exec("git", [...READ, "for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"], { cwd: root, on }).catch(() => null);
      const refs = (r?.stdout ?? "").split("\n").filter(Boolean);
      const local = refs.filter((x) => x.startsWith("refs/heads/")).map((x) => x.slice(11));
      const remote = refs.filter((x) => x.startsWith("refs/remotes/") && !x.endsWith("/HEAD")).map((x) => x.slice(13))
        .filter((x) => !local.includes(x.slice(x.indexOf("/") + 1)));
      this.menu = { ...this.menu, local, remote, loaded: true };
      cx.notify();
    });
  }

  choices() {
    const q = this.filter.value().trim(), has = (x) => x.toLowerCase().includes(q.toLowerCase());
    const list = [...this.menu.local.filter(has).map((name) => ({ kind: "local", name })), ...this.menu.remote.filter(has).map((name) => ({ kind: "remote", name }))];
    if (q && !this.menu.local.includes(q) && /^[^\s~^:?*[\\]+$/.test(q)) list.push({ kind: "new", name: q });
    return list;
  }

  pickBranch(choice, cx) {
    const { root, on, current } = props().branchMenu;
    if (!choice || this.menu.busy) return;
    if (choice.kind === "local" && choice.name === current) { closeOverlay(props().overlay); return; }
    const args = choice.kind === "new" ? ["switch", "-c", choice.name] : choice.kind === "remote" ? ["switch", "--track", choice.name] : ["switch", choice.name];
    this.menu = { ...this.menu, busy: true };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("git", args, { cwd: root, on }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.menu = { ...this.menu, busy: false };
      if (r.code === 0) { closeOverlay(props().overlay); return; }
      notify({ title: "Couldn't switch branch", body: (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" "), level: "error" });
      cx.notify();
    });
  }

  branches(t) {
    const { current } = props().branchMenu;
    const list = this.choices(), at = Math.min(this.menu.at, Math.max(0, list.length - 1));
    const row = (c, i) => h_flex().id(`fc-br-${c.kind}-${c.name}`).h(28).px(8).gap(8).flex_none().items_center().rounded(6).cursor_pointer()
      .when(i === at, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pickBranch(c, cx))
      .child(svg(HERDR(c.kind === "new" ? "plus" : "git-branch")).size(12).flex_none().text_color(c.kind === "remote" ? t.dim : t.muted))
      .child(div().flex_1().min_w(0).truncate().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .text_color(c.kind === "remote" ? t.muted : t.foreground).child(c.kind === "new" ? `Create ${c.name}` : c.name))
      .when(c.kind === "local" && c.name === current, (e) => e.child(svg(HERDR("check")).size(12).flex_none().text_color(t.accent)))
      .when(c.kind === "remote", (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child("remote")));
    return v_flex().id("fc-branches").size_full().p(5).gap(4).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        const n = list.length;
        if (!n) return;
        if (e.key === "down") this.menu = { ...this.menu, at: (at + 1) % n };
        else if (e.key === "up") this.menu = { ...this.menu, at: (at + n - 1) % n };
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(div().h(32).px(10).flex().flex_none().items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
        .child(Input.new(this.filter).w_full().text_size(12.5).text_color(t.foreground)))
      .child(v_flex().id("fc-branch-list").h(Math.min(260, 28 * Math.max(1, list.length))).flex_none().overflow_y_scrollbar().children(list.map(row))
        .when(!list.length, (e) => e.child(div().p(8).text_size(12).text_color(t.dim).child(this.menu.loaded ? "No branch matches" : "Reading branches…"))))
      .when(this.menu.busy, (e) => e.child(div().px(8).pb(2).text_size(11).text_color(t.dim).child("Switching…")));
  }

  render(cx) {
    const t = theme();
    if (props()?.branchMenu) return this.branches(t);
    if (this.stale && this.shown()) { this.stale = false; this.refresh(cx); }
    if (whereKey() !== this.ctx) this.refresh(cx);
    const b = this.branch, busy = Boolean(this.busy);
    const staged = this.files.filter((f) => f.side === "staged"), changes = this.files.filter((f) => f.side === "changes");
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const ready = Boolean(this.message.value().trim() && this.root && !busy && !this.loading && this.files.length);
    const net = { timeout: 120000 };
    const dirIds = this.tree ? [...changeTree(staged, "staged", new Set()), ...changeTree(changes, "changes", new Set())].filter((r) => r.kind === "dir").map((r) => r.id) : [];
    const allShut = dirIds.length > 0 && dirIds.every((id) => this.folded.has(id));
    const viewTools = [
      dirIds.length > 0 && this.tool(t, "fc-fold-all", OWN(allShut ? "unfold" : "fold"), allShut ? "Unfold every folder" : "Fold every folder", (cx) => {
        this.folded = allShut ? new Set([...this.folded].filter((id) => !dirIds.includes(id))) : new Set([...this.folded, ...dirIds]);
        cx.notify();
      }),
      this.tool(t, "fc-view", OWN(this.tree ? "list" : "tree"), this.tree ? "Show as a list" : "Show as a folder tree", (cx) => {
        this.tree = !this.tree; saveView(this.tree); cx.notify();
      }),
    ].filter(Boolean);
    const headTool = (id, icon, label, tip, action, show = true) => !show ? null : h_flex().id(id).h(24).px(6).gap(4).flex_none().items_center().rounded(6)
      .text_size(11.5).text_color(busy ? t.dim : t.muted).tooltip(tip).when(!busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { if (!busy) action(cx); }).child(svg(icon).size(12)).when(Boolean(label), (e) => e.child(label));
    const section = (side, label, files) => !files.length ? [] : [
      h_flex().id(`fc-sec-${side}`).h(28).flex_none().px(8).gap(8).items_center().text_size(11).font_semibold().text_color(t.dim)
        .child(this.checkbox(t, `fc-all-${side}`, side === "staged", side === "staged" ? "Unstage all" : "Stage all", (cx) => this.setAll(cx, side !== "staged")))
        .child(div().child(label.toUpperCase())).child(div().child(String(files.length))),
      ...this.sectionRows(t, side, files),
    ];
    const button = (id, label, primary, action) => div().id(id).h(32).px(12).flex().flex_none().items_center().rounded(8).text_size(12)
      .bg(ready ? (primary ? t.solid : t.raised) : t.raised).text_color(ready ? (primary ? t.solid_foreground : t.foreground) : t.dim)
      .border_1().border_color(primary ? (ready ? t.solid : t.border) : t.border).when(ready, (e) => e.cursor_pointer().hover((s) => s.opacity(0.9)).on_click(action)).child(label);
    return v_flex().id("falcon-changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(12).gap(6).items_center().border_b_1().border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .when(Boolean(b), (e) => e.child(h_flex().id("fc-branch").min_w(0).flex_shrink(1).h(24).px(6).gap(4).items_center().rounded(6).cursor_pointer().bg(t.raised)
          .hover((s) => s.bg(t.hover)).on_click(() => openOverlay({ mod: MOD, kind: "popup", width: 300, height: 330, props: { branchMenu: { root: this.root, on: this.on, current: b.name } } }))
          .child(svg(HERDR("git-branch")).size(11).flex_none().text_color(t.dim))
          .child(div().min_w(0).truncate().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5).child(b.name ?? ""))
          .child(svg(HERDR("chevron-down")).size(10).flex_none().text_color(t.dim))))
        .when(Boolean(b?.upstream && b.ahead > 0), (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`↑${b.ahead}`)))
        .when(Boolean(b?.upstream && b.behind > 0), (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi3).child(`↓${b.behind}`)))
        .child(div().flex_1())
        .when(busy, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${this.busy}…`)))
        .when(Boolean(b), (e) => e.children([
          headTool("fc-fetch", OWN("fetch"), null, "Fetch", (cx) => this.act(cx, "Fetch", [["fetch", "--prune"]], net)),
          headTool("fc-pull", OWN("pull"), b?.behind ? String(b.behind) : null, "Pull (fast-forward only)", (cx) => this.act(cx, "Pull", [["pull", "--ff-only"]], net), b?.upstream),
          headTool("fc-push", OWN("push"), b?.ahead ? String(b.ahead) : null, b?.upstream ? "Push" : "Push and set the upstream",
            (cx) => this.act(cx, "Push", [b.upstream ? ["push"] : ["push", "-u", "origin", "HEAD"]], net)),
          headTool("fc-stash", OWN("stash"), b?.stashes ? String(b.stashes) : null, "Stash every change (new files too)", (cx) => this.act(cx, "Stash", [["stash", "push", "-u"]]), this.files.length > 0),
          headTool("fc-unstash", OWN("unstash"), null, `Apply the last stash and drop it (${b?.stashes} stashed)`, (cx) => this.act(cx, "Unstash", [["stash", "pop"]]), b?.stashes > 0),
        ].filter(Boolean))))
      .when(this.files.length > 0, (e) => e.child(h_flex().h(26).flex_none().pl(14).pr(10).gap(8).items_center().text_size(11).text_color(t.dim)
        .child(`${new Set(this.files.map((f) => f.path)).size} files`).child(div().text_color(t.ansi2).child(`+${add}`)).child(div().text_color(t.ansi1).child(`−${del}`))
        .child(div().flex_1()).children(viewTools)))
      .child(v_flex().id("fc-list").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .children([...section("staged", "Staged", staged), ...section("changes", "Changes", changes)])
        .when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Reading changes…" : this.root ? "Nothing changed" : "No folder"))))
        .when(this.limited, (e) => e.child(div().p(8).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_FILES} changed files`))))
      .when(Boolean(this.note), (e) => e.child(div().px(12).pb(6).text_size(11.5).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(6).border_t_1().border_color(t.border)
        .child(Input.new(this.message).flex_1().min_w(0).h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(button("fc-commit", this.busy === "Commit" ? "Committing…" : staged.length || !changes.length ? "Commit" : "Commit all", true, (_e, cx) => this.commit(cx, false)))
        .child(button("fc-commit-push", this.busy === "Commit & push" ? "Pushing…" : "& push", false, (_e, cx) => this.commit(cx, true))));
  }
}
