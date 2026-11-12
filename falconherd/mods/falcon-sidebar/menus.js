// falcon-sidebar's popups: a space's menu, a folder's menu, a machine's menu, and the folder dialog.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, run, openOverlay, closeOverlay, props, exec, hc, shared, setShared, notify, pickFolder, home } from "herdr";
import { machineColor, pickedColor, hereColor, MACHINE_COLORS, SPACE_PALETTE } from "./core.js";
import { COLORS, DISCONNECTED, MACHINES_CHANGED, foldersOf, changeFolders, askNewSpace, machineList, newFolderId, setMachineColor } from "./store.js";
import { askMachine } from "./machines.js";

const HERDR = (name) => `mods/workspace-chrome/${name}.svg`;
export const TONES = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
export const fill = (t, c) => (!c ? t.dim : c.startsWith("#") ? c : TONES[c] ?? t[c] ?? t.dim);
export const FOLDER_COLORS = [null, "ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
const lastName = (p) => { const s = String(p ?? "").trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""; return s === "~" ? "" : s; };

const item = (t, id, label, action, { danger = false, icon = null } = {}) => h_flex().id(id).h(30).px(10).gap(8).flex_none().items_center().rounded(6).cursor_pointer()
  .text_color(danger ? t.blocked : t.foreground).hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx))
  .when(Boolean(icon), (el) => el.child(svg(HERDR(icon)).size(13).flex_none().text_color(t.muted))).child(label);
const swatches = (t, id, colors, current, pick) => h_flex().px(8).pt(6).pb(8).gap(6).flex_wrap()
  .children(colors.map((c) => div().id(`${id}-${c ?? "none"}`).size(20).flex_none().rounded(10).cursor_pointer().bg(fill(t, c))
    .border_2().border_color(c === current ? t.foreground : t.popover).hover((s) => s.border_color(t.muted)).on_click((_e, cx) => pick(c, cx))));
const box = (t) => v_flex().size_full().p(5).gap(1).bg(t.popover).text_color(t.foreground).text_size(12.5);
const close = () => closeOverlay(props().overlay);

// ----- a space's menu: its color, rename, worktrees (in a git checkout), close
export function initSpaceMenu(view, cx) {
  const s = spaces().find((x) => x.id === props().spaceMenu);
  view.git = null;
  const tabs = new Set((s?.tabs ?? []).map((x) => x.id));
  const place = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s?.folder;
  if (!place) return;
  cx.spawn(async (cx) => {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: place, on: s.machine }).catch(() => null);
    const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: place, on: s.machine }).catch(() => null);
    if (top?.code === 0 && common?.code === 0) view.git = common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
    cx.notify();
  });
}

export function spaceMenu(view, t) {
  const id = props().spaceMenu;
  const current = (shared(COLORS) ?? {})[id];
  const worktree = (action) => openOverlay({ mod: "worktree", kind: "dialog", width: action === "open" ? 560 : 440, height: action === "open" ? 480 : 260, props: { space: id, action } });
  return box(t)
    .child(swatches(t, "rs-color", SPACE_PALETTE, current, (c) => { setShared(COLORS, { ...(shared(COLORS) ?? {}), [id]: c }); close(); }))
    .child(item(t, "rs-auto", "Color: automatic", () => { const rest = { ...(shared(COLORS) ?? {}) }; delete rest[id]; setShared(COLORS, rest); close(); }, { icon: "circle-check" }))
    .child(item(t, "rs-rename", "Rename", () => { close(); run("space.rename", { id }); }, { icon: "square-pen" }))
    .when(Boolean(view.git), (el) => el
      .child(item(t, "rs-wt-new", "New worktree…", () => { close(); worktree("new"); }, { icon: "git-branch" }))
      .child(item(t, "rs-wt-open", "Open worktree…", () => { close(); worktree("open"); }, { icon: "branch" })))
    .when(view.git === "linked", (el) => el.child(item(t, "rs-wt-rm", "Remove this worktree…", () => { close(); worktree("remove"); }, { icon: "minus" })))
    .child(item(t, "rs-close", "Close the space", () => { close(); run("space.close", { id }); }, { icon: "x", danger: true }));
}

// ----- a folder's menu: color, new space, edit, move, delete (asked first)
export function folderMenu(view, t) {
  const { folderMenu: id, machine = null } = props();
  const data = foldersOf(machine);
  const i = data.list.findIndex((f) => f.id === id);
  const f = data.list[i];
  if (!f) return box(t).child(div().p(8).text_color(t.dim).child("This folder is gone"));
  const set = (patch) => changeFolders(machine, (d) => ({ ...d, list: d.list.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const move = (by) => changeFolders(machine, (d) => {
    const list = [...d.list];
    const [it] = list.splice(i, 1);
    list.splice(Math.max(0, Math.min(list.length, i + by)), 0, it);
    return { ...d, list };
  });
  if (view.asking) {
    return box(t).child(div().px(8).py(6).text_color(t.muted).child(`Delete ${f.name}? Its spaces stay, out of any folder.`))
      .child(h_flex().px(8).gap(6).justify_end()
        .child(item(t, "rf-keep", "Keep", (cx) => { view.asking = false; cx.notify(); }))
        .child(item(t, "rf-delete-yes", "Delete", () => {
          changeFolders(machine, (d) => ({ list: d.list.filter((x) => x.id !== id), of: Object.fromEntries(Object.entries(d.of).filter(([, v]) => v !== id)), at: d.at }));
          close();
        }, { danger: true })));
  }
  return box(t)
    .child(swatches(t, "rf-color", FOLDER_COLORS, f.color ?? null, (c) => { set({ color: c }); close(); }))
    .child(item(t, "rf-new", "New space here", () => { askNewSpace(machine, id); close(); }, { icon: "plus" }))
    .child(item(t, "rf-edit", "Edit folder…", () => { close(); openOverlay({ mod: "falcon-sidebar", kind: "dialog", width: 470, height: 400, props: { folderDialog: id, machine } }); }, { icon: "square-pen" }))
    .when(i > 0, (el) => el.child(item(t, "rf-up", "Move up", () => { move(-1); close(); }, { icon: "chevron-left" })))
    .when(i < data.list.length - 1, (el) => el.child(item(t, "rf-down", "Move down", () => { move(1); close(); }, { icon: "chevron-right" })))
    .child(item(t, "rf-delete", "Delete folder…", (cx) => { view.asking = true; cx.notify(); }, { icon: "x", danger: true }));
}

// ----- the folder dialog (a new one: props.fresh)
export function initFolderDialog(view) {
  const { folderDialog: id, machine = null } = props();
  const f = foldersOf(machine).list.find((x) => x.id === id) ?? { name: "New folder" };
  view.name = InputState.new({ value: f.name ?? "" });
  view.start = InputState.new({ value: f.start ?? "", placeholder: "~/code/my-project" });
  view.rules = InputState.new({ value: f.rules ?? "", placeholder: "my-project, ~/code/client-*" });
  // The rules follow the start folder, and the name its last part, until they're given their own.
  view.rulesFollow = !f.rules || f.rules === f.start;
  view.nameFollows = !f.name || f.name === "New folder" || f.name === lastName(f.start);
  view.start.on("change", (_e, cx) => { followStart(view); cx.notify(); });
  view.rules.on("change", () => { view.rulesFollow = view.rules.value() === view.start.value(); });
  view.name.on("change", () => { const n = view.name.value(); view.nameFollows = !n || n === "New folder" || n === lastName(view.start.value()); });
  for (const input of [view.name, view.start, view.rules]) input.on("submit", () => saveFolder(view));
  view.name.focus();
}
function followStart(view) {
  if (view.rulesFollow) view.rules.set_value(view.start.value());
  const last = lastName(view.start.value());
  if (view.nameFollows && last) view.name.set_value(last);
}
function saveFolder(view) {
  const { folderDialog: id, machine = null, fresh = false } = props();
  const name = view.name.value().trim(), start = view.start.value().trim() || null, rules = view.rules.value().trim() || null;
  changeFolders(machine, (d) => {
    const has = d.list.some((x) => x.id === id);
    if (!has && !fresh) return d; // deleted meanwhile
    const list = has ? d.list : [...d.list, { id, name: "New folder", folded: false, color: null }];
    return { ...d, list: list.map((x) => (x.id === id ? { ...x, name: name || x.name, start, rules } : x)) };
  });
  close();
}
export function folderDialog(view, t) {
  const { machine = null, fresh = false } = props();
  const field = (label, input, hint, extra = null) => v_flex().gap(5)
    .child(div().text_size(12).font_medium().text_color(t.muted).child(label))
    .child(h_flex().gap(6).child(Input.new(input).flex_1().h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground))
      .when(Boolean(extra), (el) => el.child(extra)))
    .when(Boolean(hint), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(hint)));
  const button = (id, label, primary, action) => div().id(id).h(32).px(14).flex().items_center().rounded(8).cursor_pointer().text_size(12.5).font_medium()
    .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).border_1().border_color(primary ? t.solid : t.input)
    .hover((s) => s.opacity(0.9)).on_click(action).child(label);
  const choose = !machine ? button("rd-choose", "Choose…", false, (_e, cx) => cx.spawn(async (cx) => {
    const picked = await pickFolder({ prompt: "Start new spaces in" }).catch(() => null);
    if (!picked) return;
    const h = home().replace(/\\/g, "/"), p = picked.replace(/\\/g, "/");
    view.start.set_value(p.startsWith(`${h}/`) || p === h ? `~${p.slice(h.length)}` : p);
    followStart(view);
    cx.notify();
  })) : null;
  return v_flex().id("sidebar-folder-dialog").size_full().p(20).gap(14).bg(t.popover).text_color(t.foreground).text_size(13)
    .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
    .child(div().text_size(15).font_semibold().child(fresh ? `New folder${machine ? ` on ${machine}` : ""}` : "Edit folder"))
    .child(field("Name", view.name, null))
    .child(field("Start new spaces in", view.start, "Its + and New space here open a space there.", choose))
    .child(field("Collect spaces from", view.rules, "Spaces working in these folders join it. Comma-separated: a folder name like my-project, or a path like ~/code/client-*."))
    .child(div().flex_1())
    .child(h_flex().gap(8).justify_end().child(button("rd-cancel", "Cancel", false, () => close())).child(button("rd-save", "Save", true, () => saveFolder(view))));
}

// ----- a machine's menu (this computer's too): New space, New folder, its color; another machine's
// connection things on a page of their own (Reconnect, Disconnect / Connect, Update hc, Forget).
// props.machineMenu: { name } (null: this computer). The actions are done by the list (machines.js).
export const machineMenuSize = (name) => ({ width: 272, height: name ? 186 : 148 });

export function initMachineMenu(view, cx) {
  view.page = "main"; view.busy = null; view.info = null;
  const { name } = props().machineMenu;
  if (name) cx.spawn(async (cx) => { view.info = (await machineList())?.find((m) => m.name === name) ?? null; cx.notify(); });
}

const divider = (t) => div().h(1).mx(8).my(4).flex_none().bg(t.border);
const pageLink = (t, id, label, action) => h_flex().id(id).h(30).px(10).gap(8).flex_none().items_center().rounded(6).cursor_pointer()
  .text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx))
  .child(svg(HERDR("server")).size(13).flex_none().text_color(t.muted)).child(div().flex_1().child(label))
  .child(svg(HERDR("chevron-right")).size(11).flex_none().text_color(t.dim));

function connectionPage(view, t, name, head) {
  const back = h_flex().id("rm-back").h(28).px(8).gap(6).flex_none().items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.dim)
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { view.page = "main"; cx.notify(); })
    .child(svg(HERDR("chevron-left")).size(11)).child(head);
  const canDisconnect = Boolean(view.info?.target) && !view.info?.via;
  return box(t).child(back)
    .child(item(t, "rm-reconnect", "Reconnect now", () => { askMachine(name, "reconnect"); close(); }, { icon: "circle-check" }))
    .when(canDisconnect, (el) => el.child(item(t, "rm-disconnect", "Disconnect", () => { askMachine(name, "disconnect", { target: view.info.target, session: view.info.session ?? null }); close(); }, { icon: "minus" })))
    .child(item(t, "rm-update", "Update hc there", () => { askMachine(name, "update"); close(); }, { icon: "layers" }))
    .child(item(t, "rm-forget", `Forget ${name}…`, (cx) => { view.page = "forget"; cx.notify(); }, { icon: "x", danger: true }));
}

export function machineMenu(view, t) {
  const { name = null } = props().machineMenu;
  const away = name ? (shared(DISCONNECTED) ?? {})[name] : null;
  const forgetAway = () => { const rest = { ...(shared(DISCONNECTED) ?? {}) }; delete rest[name]; setShared(DISCONNECTED, rest); };
  const color = (name ? machineColor(name) : hereColor()) ?? t.muted;
  const state = !name ? null : away ? "disconnected" : view.info?.state?.replace(/_/g, " ") ?? "…";
  const head = () => h_flex().gap(6).items_center()
    .child(svg(HERDR(name ? "server" : "monitor")).size(12).text_color(color)).child(div().text_color(color).child(name ?? "This computer"))
    .when(Boolean(state), (el) => el.child(`· ${state}`));
  const title = h_flex().h(26).px(10).flex_none().items_center().text_size(11.5).text_color(t.dim).child(head());
  if (view.busy) return box(t).child(title).child(div().px(10).py(6).text_color(t.dim).child(view.busy));
  if (view.page === "forget") {
    return box(t).child(div().px(10).py(6).text_color(t.muted).child(`Forget ${name}? Its terminals keep running there; it leaves this sidebar until it's added again (hc machine add).`))
      .child(h_flex().px(6).gap(6).justify_end()
        .child(item(t, "rm-cancel", "Cancel", (cx) => { view.page = "connection"; cx.notify(); }))
        .child(item(t, "rm-forget-yes", "Forget", () => { askMachine(name, "forget"); close(); }, { danger: true })));
  }
  if (view.page === "connection") return connectionPage(view, t, name, head());
  if (away) {
    return box(t).child(title)
      .child(item(t, "rm-connect", "Connect", () => { askMachine(name, "connect"); close(); }, { icon: "server" }))
      .child(item(t, "rm-drop", "Remove from the sidebar", () => { forgetAway(); setShared(MACHINES_CHANGED, Date.now()); close(); }, { icon: "x" }));
  }
  const picked = pickedColor(name);
  const pick = (c, cx) => {
    if (view.busy) return;
    view.busy = "Saving the color…"; cx.notify();
    cx.spawn(async () => {
      try { await setMachineColor(name, c); } catch (e) { notify({ title: "Couldn't save the color", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 7000 }); }
      close();
    });
  };
  return box(t).child(title)
    .child(item(t, "rm-new-space", "New space", () => { askNewSpace(name, null); close(); }, { icon: "plus" }))
    .child(item(t, "rm-new-folder", "New folder…", () => { close(); openOverlay({ mod: "falcon-sidebar", kind: "dialog", width: 470, height: 400, props: { folderDialog: newFolderId(), machine: name, fresh: true } }); }, { icon: "folder-plus" }))
    .child(swatches(t, "rm-color", [null, ...MACHINE_COLORS], picked && MACHINE_COLORS.includes(picked) ? picked : null, pick))
    .when(Boolean(name), (el) => el.child(divider(t)).child(pageLink(t, "rm-connection", "Connection", (cx) => { view.page = "connection"; cx.notify(); })));
}

export { newFolderId };
