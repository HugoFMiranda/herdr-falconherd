// Read-only Markdown view, shared by mods/falcon-md (floating window) and mods/falcon-files
// (side panel) — same file in both (mods can't import each other; source: mods/falcon-md).
import { div } from "gpui-kit";
import { v_flex, TextView, Editor, EditorState } from "gpui-base";
import { theme, settings } from "herdr";

export { isMarkdown } from "./core.js";
import { resolveLink } from "./core.js";
const MAX = 400000;

// A source view for the raw text.
export function sourceState(text) {
  const t = theme();
  return EditorState.new({ language: "markdown", readonly: true, value: text.length > MAX ? text.slice(0, MAX) + "\n… (file truncated)" : text,
    font_family: settings().font_family, font_size: 12,
    syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
}

// The formatted document; onLink gets the resolved target ({ web } or { file }).
export function formatted(id, text, file, onLink) {
  return v_flex().id(`${id}-scroll`).flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14)
    .child(div().max_w(760).text_size(13.5)
      .child(TextView.markdown(id, text.length > MAX ? text.slice(0, MAX) : text).selectable(true)
        .on_link_click((url, cx) => {
          const to = resolveLink(file, url);
          if (to?.web) { try { cx.open_url(to.web); } catch {} }
          else if (to?.file) onLink(to.file, cx);
        })));
}

export const source = (state) => Editor.new(state).flex_1().min_h(0);
