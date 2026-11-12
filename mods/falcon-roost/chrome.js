// The sidebar's top bar and footer (falcon-roost's parts "top" and "foot"), and the rail toggle.
//   Top: Herdr's mark and name, Search, and the toggle that folds the sidebar to a rail of icons (on
//   the rail: the toggle alone, centered; on macOS the traffic lights take the row).
//   Foot: Settings (a dot when an update is ready) and Add machine; on the rail they stack, and the
//   block grows to fit them.
import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, window, shared, setShared, layout, updates, openOverlay } from "herdr";
import { settingsOverlay } from "./core.js";

const HERDR = (name) => `mods/workspace-chrome/${name}.svg`;
export const findNode = (node, id) => (node?.id === id ? node : (node?.children ?? []).map((c) => findNode(c, id)).find(Boolean) ?? null);
// The rail goes by the sidebar's width (dragging its edge narrows it too).
export const onRail = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (wide enough for the traffic lights on macOS), or back to the width it had.
export function toggleRail() {
  const width = findNode(layout(), "sidebar")?.size?.px;
  if (!onRail()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !onRail());
  run("layout.resize", { id: "sidebar", px: onRail() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const iconButton = (t, id, icon, tip, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(7)
  .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(svg(HERDR(icon)).size(15));

export function topBar(t) {
  const mac = window()?.platform === "macos";
  if (onRail()) return h_flex().size_full().bg(t.chrome).items_center().justify_center()
    .when(!mac, (el) => el.child(iconButton(t, "roost-unfold", "sidebar", "Open the sidebar", toggleRail)));
  return h_flex().size_full().bg(t.chrome).pl(mac && !window()?.fullscreen ? 76 : 14).pr(10).gap(4).items_center()
    .child(h_flex().flex_1().min_w(0).gap(8).items_center()
      .child(image("frame/welcome/herdr.png").size(20).rounded(5))
      .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child("Herdr")))
    .child(iconButton(t, "roost-search", "search", "Search", () => run("mod.open", { name: "picker" })))
    .child(iconButton(t, "roost-fold", "sidebar", "Fold the sidebar", toggleRail));
}

const ROW = 41, STACKED = 69;
// The footer block stacks its buttons on the rail: its height follows (from a timer, not render).
export function fitFooter() {
  const want = onRail() ? STACKED : ROW;
  if (findNode(layout(), "sidebar-footer")?.size?.px !== want) run("layout.resize", { id: "sidebar-footer", px: want });
}
export function footer(t) {
  const rail = onRail();
  const ready = Boolean(updates().app.ready);
  const settings = () => openOverlay(settingsOverlay(ready ? "updates" : "look"));
  const addMachine = () => run("mod.open", { name: "machine-add" });
  const item = (id, icon, action) => h_flex().id(id).h(28).gap(9).items_center().rounded(8).cursor_pointer()
    .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(svg(HERDR(icon)).size(14).flex_none());
  const dot = () => div().size(6).flex_none().rounded(3).bg(t.accent);
  if (rail) {
    return v_flex().size_full().bg(t.chrome).border_t_1().border_color(t.border).pt(4).pb(8).items_center().gap(2)
      .child(item("roost-settings", "settings", settings).relative().w(32).justify_center().tooltip(ready ? "Settings · an update is ready" : "Settings")
        .when(ready, (el) => el.child(dot().absolute().top(5).right(6))))
      .child(item("roost-add-machine", "plus", addMachine).w(28).justify_center().tooltip("Add a machine"));
  }
  return h_flex().size_full().bg(t.chrome).border_t_1().border_color(t.border).px(8).gap(2).items_center().text_size(13)
    .child(item("roost-settings", "settings", settings).flex_1().px(8).child("Settings").when(ready, (el) => el.child(dot())))
    .child(item("roost-add-machine", "plus", addMachine).w(28).justify_center().tooltip("Add a machine"));
}
