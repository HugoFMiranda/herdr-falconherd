// Pieces for this repo's Settings sections, drawn like Herdr's own (frame/settings): an uppercase
// heading, rows divided by a line, the same buttons and toggle.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";

export const heading = (t, text) => div().pt(6).pb(8).text_size(12).font_semibold().text_color(t.dim).child(text.toUpperCase());

// A heading with the section's action on the right (Add…), so it's there however long the list gets.
export const headingRow = (t, text, action = null) => h_flex().w_full().items_center().gap(8)
  .when(Boolean(action), (el) => el.pb(10)) // the button is taller than the heading: room before the text under it
  .child(div().flex_1().child(heading(t, text))).when(Boolean(action), (el) => el.child(action));

export const about = (t, text) => div().pb(8).text_size(12.5).line_height("18px").text_color(t.dim).child(text);

export const note = (t, text, color = null) => div().text_size(12).line_height("17px").text_color(color ?? t.dim).child(text);

// primary: the one that finishes a form.
export const button = (t, id, label, onClick, { primary = false, disabled = false } = {}) => div().id(id).px(12).py(5).flex_none().rounded(7).border_1()
  .border_color(primary ? t.accent : t.border).bg(primary ? t.accent : t.raised).text_size(13)
  .text_color(primary ? t.accent_foreground : t.foreground)
  .when(disabled, (b) => b.opacity(0.45))
  .when(!disabled, (b) => b.cursor_pointer().hover((s) => (primary ? s.opacity(0.9) : s.bg(t.hover))).on_click(onClick))
  .child(label);

// A small square button with a glyph (move up/down).
export const iconButton = (t, id, glyph, tip, onClick, disabled = false) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5)
  .when(disabled, (b) => b.opacity(0.3))
  .when(!disabled, (b) => b.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick).tooltip(tip))
  .child(svg(glyph).size(13).text_color(t.muted));

export const toggle = (t, id, on, onClick) => div().id(id).w(36).h(20).flex_none().rounded(10).p(2).cursor_pointer()
  .bg(on ? t.accent : t.hover).flex().when(on, (el) => el.justify_end()).on_click(onClick)
  .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));

// A small label in a color (an account's, or dim).
export const chip = (t, text, color = null) => div().flex_none().px(6).py(1).rounded(5).text_size(11)
  .text_color(color ?? t.dim).bg((color ?? t.dim) + "1f").child(text);

// A row: its icon, what it is (title, a line under it), the controls on the right.
// lead: controls before the icon (moving it).
export const row = (t, id, { lead = null, icon, title, sub, controls, dim = false, highlight = false, compact = false }) => h_flex().id(id).w_full().gap(12).py(compact ? 6 : 10).items_center()
  .border_b(1).border_color(t.border).when(highlight, (el) => el.bg(t.raised).rounded(7))
  .when(Boolean(lead), (el) => el.child(h_flex().flex_none().gap(2).items_center().child(lead)))
  .child(div().w(22).flex_none().flex().justify_center().when(dim, (el) => el.opacity(0.4)).child(icon ?? div()))
  .child(v_flex().flex_1().min_w(0).gap(3)
    .child(title)
    .when(Boolean(sub), (el) => el.child(div().truncate().text_size(12).font_family("JetBrains Mono").text_color(t.dim).child(sub))))
  .child(h_flex().flex_none().gap(6).items_center().children(controls ?? []));

export const title = (t, text, extra = []) => h_flex().gap(8).items_center().min_w(0)
  .child(div().truncate().text_size(14).text_color(t.foreground).child(text)).children(extra);

// A labelled input.
export const field = (t, label, input, { mono = false, grow = true } = {}) => v_flex().gap(5).min_w(0).when(grow, (el) => el.flex_1())
  .child(div().text_size(12).text_color(t.muted).child(label))
  .child(Input.new(input).w_full().h(32).px(10).rounded(7).border_1().border_color(t.input).bg(t.background)
    .text_size(13).text_color(t.foreground).when(mono, (i) => i.font_family("JetBrains Mono")));

export const swatch = (t, id, color, chosen, onClick) => div().id(id).size(22).flex_none().rounded(11).cursor_pointer().bg(color)
  .border_2().border_color(chosen ? t.foreground : t.background).hover((s) => s.border_color(t.muted)).on_click(onClick);

// An icon: a one-color glyph in `color`, or a picture.
export const pic = (path, size, color) => (color ? svg(path).size(size).flex_none().text_color(color) : image(path).w(size).h(size).flex_none());

export const iconChoice = (t, id, path, color, chosen, onClick, tip) => div().id(id).p(5).flex_none().rounded(7).cursor_pointer().border_2()
  .border_color(chosen ? t.accent : t.background).bg(chosen ? t.raised : t.background).hover((s) => s.bg(t.hover))
  .on_click(onClick).when(Boolean(tip), (el) => el.tooltip(tip)).child(pic(path, 20, color));

// Two or more choices in one control (Claude | Codex).
export const segmented = (t, id, options, value, onPick) => h_flex().id(id).flex_none().rounded(7).border_1().border_color(t.border).bg(t.raised).p(2).gap(2)
  .children(options.map(([v, label]) => div().id(`${id}-${v}`).px(10).py(3).rounded(5).cursor_pointer().text_size(12.5)
    .bg(v === value ? t.background : t.raised).text_color(v === value ? t.foreground : t.muted)
    .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => onPick(v, cx)).child(label)));

// A form, in place of a row.
export const form = (t, id) => v_flex().id(id).w_full().my(8).p(14).gap(12).rounded(9).border_1().border_color(t.accent).bg(t.raised);

export const label = (t, text) => div().text_size(12).text_color(t.muted).child(text);

export const problems = (t, list) => v_flex().gap(3).children(list.map((p) => div().text_size(12).text_color(t.blocked).child(p)));
