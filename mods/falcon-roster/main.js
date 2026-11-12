// falcon-roster: the Accounts and + menu sections in a window of their own (the shared Falconherd
// opens this from Settings links; here they're also inside the Settings copy). Its sections are
// copies (accounts.js, launchers.js, store.js, ui.js) of the ones the Settings sections use.
// props: { section: "accounts" | "menu" }. Changes save as they're made (store.js).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, closeOverlay } from "herdr";
import { mySectionsInit } from "./store.js";
import { accountsSection } from "./accounts.js";
import { menuSection } from "./launchers.js";

const TABS = [
  { id: "accounts", title: "Accounts", icon: "mods/falcon-roster/accounts.svg" },
  { id: "menu", title: "+ menu", icon: "mods/falcon-roster/menu.svg" },
];

export default class FalconRoster extends View {
  init(_props, cx) {
    const asked = props()?.section;
    this.section = TABS.some((x) => x.id === asked) ? asked : "accounts";
    mySectionsInit(this, cx);
  }

  tab(t, x) {
    const on = this.section === x.id;
    return h_flex().id(`roster-tab-${x.id}`).h(30).px(12).gap(7).items_center().rounded(7).cursor_pointer().text_size(12.5)
      .when(on, (el) => el.bg(t.selected).text_color(t.foreground)).when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.section = x.id; if (this.mine) this.mine.editing = null; cx.notify(); })
      .child(svg(x.icon).size(13).flex_none()).child(x.title);
  }

  render() {
    const t = theme();
    const m = this.mine;
    const body = !m?.loaded
      ? div().py(14).text_size(12.5).text_color(t.dim).child("Reading…")
      : this.section === "menu" ? menuSection(m, t) : accountsSection(m, t);
    return v_flex().size_full().bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().h(46).flex_none().px(14).gap(4).items_center().border_b_1().border_color(t.border)
        .children(TABS.map((x) => this.tab(t, x)))
        .child(div().flex_1())
        .child(div().id("roster-close").size(26).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => closeOverlay(props().overlay)).child(svg("mods/workspace-chrome/x.svg").size(13))))
      .child(div().id("roster-body").flex_1().min_h(0).overflow_y_scroll()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().px(24).py(18).child(body)));
  }
}
