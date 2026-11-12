// A floating window with one Markdown file. Opened by mods/falcon-files' pop-out button, the
// status bar (links clicked in a terminal) and sub-agent rows:
//   openOverlay({ kind: "window", key: `falcon-md:${file}`, mod: "falcon-md", props: { file, on } })
// A local file becomes a window of two blocks: this mod as its title bar, and a terminal running
// the herdr-md-glow helper (glow renders the file; scroll and select text like any terminal).
// The title bar's Browser button opens a full rendering (the herdr-md-browser helper).
// Without the helper or glow, the built-in view.
// A file on another machine keeps the built-in view (formatted, no selection), as before.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, readTextFile, theme, home, openOverlay, closeOverlay, exec, hc, shared, notify } from "herdr";
import { formatted, source, sourceState } from "./markdown.js";

const SIZE = "falcon-md.size";
const BIG = { w: 0.92, h: 0.9 };
const BAR = 40;
const tidy = (p) => (p.startsWith(home() + "/") ? "~" + p.slice(home().length) : p);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// The window for `file` around terminal `term`, replacing the one with the same key, in place.
function openWindow(file, term, big) {
  const size = big ? BIG : (shared(SIZE) ?? { w: 760, h: 820 });
  openOverlay({
    kind: "window", key: `falcon-md:${file}`, width: size.w, height: size.h,
    layout: { type: "column", children: [
      { type: "block", size: { px: BAR }, content: { mod: "falcon-md", props: { file, term, big } } },
      { type: "block", content: { terminal: term } },
    ] },
  });
}

export default class MdView extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.file = p.file ?? null;
    this.on = p.on ?? null;
    this.term = p.term ?? null;
    this.big = Boolean(p.big);
    this.replacing = false;
    if (this.term) return; // title bar
    this.text = null; this.code = null; this.showSource = false; this.error = null;
    if (this.file && !this.on) { this.launch(cx); return; }
    this.fallback(cx);
  }

  // Start the glow terminal, then turn this window into the title bar + terminal one.
  launch(cx) {
    cx.spawn(async (cx) => {
      const glow = `${home()}/.local/bin/herdr-md-glow`;
      const ready = await exec("sh", ["-c", 'test -x "$1" && { command -v glow >/dev/null || test -x "$HOME/.local/bin/glow" || test -x /opt/homebrew/bin/glow || test -x /usr/local/bin/glow; }', "sh", glow]).catch(() => null);
      if (ready?.code !== 0) { this.fallback(cx); return; }
      const r = await hc(["run", "--json", "--no-parent", "--rm", "--bg", "--label", "herdr.falcon-md=1", "--",
        `${home()}/.local/bin/herdr-md-glow`, this.file]).catch(() => null);
      const term = parse(r?.stdout ?? "")?.address;
      if (!term) { notify({ title: "Couldn't start the Markdown viewer", level: "error" }); this.fallback(cx); return; }
      openWindow(this.file, term, false);
    });
  }

  // The built-in view, for files on other machines (and if glow can't start).
  fallback(cx) {
    const load = (cx) => cx.spawn(async (cx) => {
      if (!this.file) return;
      const text = await readTextFile(this.file, { on: this.on }).catch(() => null);
      if (text === null) { this.error = "This file is no longer available"; cx.notify(); return; }
      if (text === this.text) return;
      this.text = text; this.error = null;
      if (this.code) { this.code.release(); this.code = sourceState(text); }
      cx.notify();
    });
    this.load = load;
    load(cx);
    cx.timer.every(2000, load);
  }

  async close() {
    this.code?.release();
    // Closing the window ends its viewer; resizing reopens it around the same terminal.
    if (this.term && !this.replacing) await exec("hc", ["kill", this.term]).catch(() => null);
  }

  resize() {
    this.replacing = true;
    openWindow(this.file, this.term, !this.big);
  }

  browser() {
    exec(`${home()}/.local/bin/herdr-md-browser`, [this.file]).then((r) => {
      if (r?.code !== 0) notify({ title: "Couldn't open the browser view", body: r?.stderr?.slice(0, 200), level: "error" });
    }, () => notify({ title: "Couldn't open the browser view", level: "error" }));
  }

  render() {
    const t = theme();
    const name = this.file?.split("/").pop() ?? "Markdown";
    const folder = this.file ? tidy(this.file.slice(0, this.file.lastIndexOf("/"))) : "";
    const btn = (id, child, action, tip) => div().id(id).flex_none().px(8).h(26).flex().gap(6).items_center().rounded(6).text_size(12)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => action(cx)).child(child);
    const bar = (buttons) => h_flex().h(BAR).flex_none().px(12).gap(4).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(v_flex().flex_1().min_w(0).mr(8)
        .child(div().truncate().font_semibold().text_size(13).child(name))
        .child(div().truncate().text_size(11).text_color(t.dim).child(this.on ? `${this.on}: ${folder}` : folder)))
      .children(buttons)
      .child(btn("md-close", svg("mods/falcon-md/close.svg").size(13), () => closeOverlay(props().overlay), "Close"));

    if (this.term) {
      return v_flex().id("md-bar").size_full().text_color(t.foreground).child(bar([
        btn("md-browser", h_flex().gap(6).items_center().child(svg("mods/falcon-md/popout.svg").size(12)).child("Browser"), () => this.browser(), "Open the full rendering in the browser"),
        btn("md-size", this.big ? "Smaller" : "Larger", () => this.resize(), this.big ? "Back to the usual size" : "Fill most of the window"),
      ]));
    }
    if (this.file && !this.on && !this.load) {
      return v_flex().w(360).h(120).bg(t.background).text_color(t.dim).items_center().justify_center().text_size(12).child("Opening…");
    }
    return v_flex().id("md-root").w(640).h(720).bg(t.background).text_color(t.foreground).rounded(10).overflow_hidden()
      .child(bar([btn("md-toggle", this.showSource ? "Formatted" : "Source", (cx) => {
        this.showSource = !this.showSource;
        if (this.showSource && !this.code && this.text !== null) this.code = sourceState(this.text);
        cx.notify();
      }, "Switch view")]))
      .child(v_flex().id("md-body").flex_1().min_h(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(this.error || this.text === null
          ? div().p(16).text_color(t.dim).child(this.error ?? "Loading…")
          : this.showSource && this.code ? source(this.code)
          : formatted("falcon-md-doc", this.text, this.file, (file, cx) => { this.file = file; this.text = null; this.load(cx); }, this.on)));
  }
}
