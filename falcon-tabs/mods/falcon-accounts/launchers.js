// + menu: everything the tab bar's + offers to start, in its order: this computer's own entries (a
// command, shown as one of the accounts or with an icon of its own) and Herdr's agents. Each can be
// moved (drag its handle, or the arrows) and hidden; the own ones edited and removed.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { launcherProblems, accountId, accountTitle, splitCommand, joinCommand, inMenuOrder, moveKey, toolOf, ACCOUNT_GLYPHS } from "./core.js";
import { headingRow, about, note, button, iconButton, toggle, chip, row, title, field, pic, iconChoice, form, label, problems } from "./ui.js";
import { changed, status } from "./store.js";

const UP = "mods/falcon-accounts/up.svg";
const DOWN = "mods/falcon-accounts/down.svg";
// An entry's own icon: Herdr's agent icons, then the shapes and Claude's and Codex's marks (in the text color).
const GLYPHS = [...ACCOUNT_GLYPHS.filter((g) => !g.tool), ...ACCOUNT_GLYPHS.filter((g) => g.tool)].map((g) => ({ path: g.path, tint: true, label: g.label }));
const accountOf = (m, id) => (id ? m.list.find((a) => a.id === id) ?? null : null);

// Herdr's agents (knownAgents) that aren't this computer's own entries.
const builtIns = (m) => m.agents.filter((a) => !m.launchers.some((l) => l.id === a.key) && !m.baseRun.includes(a.key));

// Every item, in the menu's order: { key, mine: launcher | null, agent: knownAgents entry | null }.
function items(m) {
  const all = [...m.launchers.map((l) => ({ key: l.id, mine: l, agent: m.agents.find((a) => a.key === l.id) ?? null })),
    ...builtIns(m).map((a) => ({ key: a.key, mine: null, agent: a }))];
  return inMenuOrder(all, m.order);
}

// keys: the rows shown, in order. The others keep their places after them, including saved ones for
// agents not known right now (still loading, or the check failed).
function move(m, keys, from, to, cx) {
  if (from < 0 || to < 0 || from >= keys.length || to >= keys.length || from === to) return;
  const listed = items(m).map((i) => i.key);
  const rest = listed.filter((k) => !keys.includes(k));
  const unknown = m.order.filter((k) => !listed.includes(k));
  m.order = [...moveKey(keys, from, to), ...rest, ...unknown];
  changed(m, cx);
}

function setHidden(m, key, hidden, cx) {
  m.hidden = hidden ? [...m.hidden, key] : m.hidden.filter((k) => k !== key);
  changed(m, cx);
}

function itemPic(m, t, it, size) {
  const a = accountOf(m, it.mine?.account);
  if (a) return pic(a.icon, size, a.color);
  const icon = it.mine?.icon ?? it.agent?.icon;
  const tint = it.mine ? it.mine.tint : it.agent?.tint;
  return icon ? pic(icon, size, tint ? t.foreground : null) : div().size(size);
}

function edit(m, index, cx, start = null) {
  const l = index == null ? { name: "", run: [], account: null, icon: null, tint: false, ...(start ?? {}) } : m.launchers[index];
  m.inputs = {
    name: InputState.new({ value: l.name, placeholder: "Claude, Claude (continue), Codex…" }),
    command: InputState.new({ value: joinCommand(l.run), placeholder: "claude --model opus" }),
  };
  m.editing = { section: "menu", kind: "launcher", index, account: l.account, icon: l.icon, tint: l.tint, problems: [] };
  cx.notify();
}

function done(m, cx) {
  const e = m.editing;
  const others = m.launchers.filter((_, i) => i !== e.index);
  const draft = { name: m.inputs.name.value().trim(), command: m.inputs.command.value(), account: e.account, icon: e.account ? null : e.icon };
  const found = launcherProblems(draft, others);
  if (found.length) { m.editing = { ...e, problems: found }; cx.notify(); return; }
  // Until Herdr's agents are known, "my-" keeps a new id off their keys (an entry named Codex would
  // otherwise change Herdr's own codex entry).
  const taken = [...others.map((l) => l.id), ...m.agents.map((a) => a.key), ...m.baseRun];
  const id = e.index == null ? accountId(m.agentsLoaded ? draft.name : `my ${draft.name}`, taken) : m.launchers[e.index].id;
  const entry = { id, name: draft.name, run: splitCommand(draft.command), account: draft.account, icon: draft.icon, tint: draft.account ? false : e.tint };
  m.launchers = e.index == null ? [...m.launchers, entry] : m.launchers.map((l, i) => (i === e.index ? entry : l));
  m.editing = null;
  changed(m, cx);
}

function remove(m, key, cx) {
  m.launchers = m.launchers.filter((l) => l.id !== key);
  m.order = m.order.filter((k) => k !== key);
  m.hidden = m.hidden.filter((k) => k !== key);
  changed(m, cx);
}

// Shown as: an account (its icon, in its color), or another program with an icon of its own.
function showsAs(m, t, e) {
  const pick = (patch) => (_e, cx) => { m.editing = { ...m.editing, ...patch }; cx.notify(); };
  const option = (id, text, icon, chosen, action) => h_flex().id(id).h(28).px(10).gap(7).items_center().rounded(7).cursor_pointer().text_size(12.5)
    .border_1().border_color(chosen ? t.accent : t.border).bg(chosen ? t.background : t.raised).text_color(chosen ? t.foreground : t.muted)
    .hover((s) => s.text_color(t.foreground)).on_click(action).when(Boolean(icon), (el) => el.child(icon)).child(text);
  const seen = new Set();
  const icons = [...m.agents.filter((a) => a.icon).map((a) => ({ path: a.icon, tint: a.tint, label: a.name })), ...GLYPHS]
    .filter((i) => (seen.has(i.path) ? false : seen.add(i.path)));
  return v_flex().gap(8)
    .child(h_flex().gap(6).flex_wrap()
      .children(m.list.map((a) => option(`l-on-${a.id}`, accountTitle(a), pic(a.icon, 14, a.color), e.account === a.id, pick({ account: a.id }))))
      .child(option("l-on-other", "Another program", null, !e.account, pick({ account: null }))))
    .when(!e.account, (el) => el.child(h_flex().gap(4).flex_wrap().children(icons.map((i, n) => iconChoice(t, `l-icon-${n}`, i.path, i.tint ? t.foreground : null,
      e.icon === i.path, pick({ icon: i.path, tint: i.tint }), i.label)))));
}

function entryForm(m, t) {
  const e = m.editing;
  return form(t, "l-form")
    .child(div().text_size(14).font_semibold().child(e.index == null ? "New + menu entry" : `Edit ${m.launchers[e.index].name}`))
    .when(e.index == null, (el) => el.child(v_flex().gap(6).child(label(t, "Start from"))
      .child(h_flex().gap(6).flex_wrap().children(startsOf(m).map((s, n) => h_flex().id(`l-start-${n}`).h(26).px(9).items_center().rounded(13)
        .cursor_pointer().text_size(12).border_1().border_color(e.start === s.start.name ? t.accent : t.border)
        .text_color(e.start === s.start.name ? t.foreground : t.muted).hover((st) => st.text_color(t.foreground))
        .on_click((_e, cx) => applyStart(m, s.start, cx)).child(s.label))))))
    .child(h_flex().gap(10).child(field(t, "Name", m.inputs.name)).child(field(t, "Command", m.inputs.command, { mono: true })))
    .child(note(t, "Runs in a new tab's shell as typed: a program or a wrapper script of yours, with its flags. Quote words with spaces."))
    .child(v_flex().gap(6).child(label(t, "Shows as")).child(showsAs(m, t, e)))
    .when(e.problems.length > 0, (el) => el.child(problems(t, e.problems)))
    .child(h_flex().gap(8).justify_end()
      .child(button(t, "l-form-cancel", "Cancel", (_e, cx) => { m.editing = null; cx.notify(); }))
      .child(button(t, "l-form-done", e.index == null ? "Add entry" : "Save", (_e, cx) => done(m, cx), { primary: true })));
}

function itemRow(m, t, it, i, keys) {
  const busy = Boolean(m.editing);
  const shown = !m.hidden.includes(it.key);
  const a = accountOf(m, it.mine?.account);
  const kind = a ? chip(t, accountTitle(a), a.color) : it.mine ? chip(t, "Program") : chip(t, it.agent?.installed === false ? "Herdr · not installed" : "Herdr");
  const name = it.mine?.name ?? it.agent?.name ?? it.key;
  const command = joinCommand(it.mine?.run ?? it.agent?.run ?? []);
  const index = m.launchers.findIndex((l) => l.id === it.key);
  const dragging = m.drag && m.drag !== it.key;
  return div().id(`li-${it.key}`).w_full()
    // Drag: press the handle on one row, let go on another.
    .on_mouse_up("left", (_e, cx) => { if (m.drag && m.drag !== it.key) { const from = keys.indexOf(m.drag); m.drag = null; move(m, keys, from, i, cx); } else if (m.drag) { m.drag = null; cx.notify(); } })
    .when(dragging, (el) => el.hover((s) => s.bg(t.hover)))
    .child(row(t, `l-row-${it.key}`, {
      lead: h_flex().gap(2).items_center()
        .child(div().id(`l-grip-${it.key}`).px(3).py(6).cursor_grab().text_color(m.drag === it.key ? t.accent : t.dim).text_size(14).tooltip("Drag to move")
          .on_mouse_down("left", (_e, cx) => { if (!busy) { m.drag = it.key; cx.stop_propagation(); cx.notify(); } }).child("⠿"))
        .child(v_flex()
          .child(iconButton(t, `l-up-${it.key}`, UP, "Move up", (_e, cx) => move(m, keys, i, i - 1, cx), busy || i === 0))
          .child(iconButton(t, `l-down-${it.key}`, DOWN, "Move down", (_e, cx) => move(m, keys, i, i + 1, cx), busy || i === keys.length - 1))),
      icon: itemPic(m, t, it, 18),
      title: title(t, name, [kind]),
      sub: command,
      dim: !shown,
      compact: true,
      highlight: m.drag === it.key,
      controls: [
        ...(it.mine ? [
          button(t, `l-edit-${it.key}`, "Edit", (_e, cx) => edit(m, index, cx), { disabled: busy }),
          button(t, `l-remove-${it.key}`, "Remove", (_e, cx) => remove(m, it.key, cx), { disabled: busy }),
        ] : []),
        toggle(t, `l-shown-${it.key}`, shown, (_e, cx) => setHidden(m, it.key, shown, cx)),
      ],
    }));
}

// Ways to start a new entry: each account (and its last conversation), each installed agent, blank.
// Ways to start a new entry: each account (and its last conversation), each installed agent.
function startsOf(m) {
  // Continuing the last conversation: Claude's and Codex's way; another program just starts.
  const forAccount = (a) => (toolOf(a) === "codex"
    ? [[accountTitle(a), [a.bin, "--no-daemon"]], [`${accountTitle(a)} (last)`, [a.bin, "--no-daemon", "resume", "--last"]]]
    : toolOf(a) === "claude" ? [[accountTitle(a), [a.bin]], [`${accountTitle(a)} (continue)`, [a.bin, "--continue"]]]
    : [[accountTitle(a), [a.bin]]])
    .map(([name, run]) => ({ label: name, start: { name, run, account: a.id } }));
  return [
    ...m.list.flatMap(forAccount),
    ...m.agents.filter((a) => a.installed && !/^(claude|codex)/.test(a.key) && !m.launchers.some((l) => l.id === a.key) && !m.baseRun.includes(a.key))
      .map((a) => ({ label: a.name, start: { name: a.name, run: a.run, icon: a.icon, tint: a.tint } })),
  ];
}

// A start fills the new entry's form (name, command, how it shows); it can still be changed.
function applyStart(m, s, cx) {
  m.inputs.name.set_value(s.name);
  m.inputs.command.set_value(joinCommand(s.run));
  m.editing = { ...m.editing, account: s.account ?? null, icon: s.icon ?? null, tint: s.tint ?? false, start: s.name, problems: [] };
  cx.notify();
}

export function menuSection(m, t) {
  const e = m.editing?.kind === "launcher" ? m.editing : null;
  const all = items(m);
  // Herdr's agents that aren't installed here fold away (on or off), so the list is what you use.
  const folded = all.filter((it) => !it.mine && it.agent?.installed === false);
  const shown = m.allAgents ? all : all.filter((it) => !folded.includes(it));
  const keys = shown.map((it) => it.key);
  // A press anywhere but a handle ends a drag that was let go outside the rows (the handle's own
  // press stops here), so a later click can't turn into a move.
  return v_flex().id("menu-section").w_full()
    .on_mouse_down("left", (_e, cx) => { if (m.drag) { m.drag = null; cx.notify(); } })
    .child(headingRow(t, "+ menu", button(t, "l-add", "Add entry", (_e, cx) => edit(m, null, cx, { account: m.list[0]?.id ?? null }), { primary: true, disabled: Boolean(m.editing || m.error) })))
    .child(about(t, "What the tab bar's + starts, in this order: drag a row by its handle or use the arrows. Your own entries run a command and show as one of your accounts; Herdr's are the agents it knows. Turn one off to leave it out."))
    .child(status(m, t))
    .when(m.agentsFailed, (el) => el.child(note(t, "Couldn't check which agents are installed.", t.blocked)))
    .when(Boolean(e && e.index == null), (el) => el.child(entryForm(m, t)))
    .children(shown.map((it, i) => (e && e.index != null && m.launchers[e.index]?.id === it.key ? entryForm(m, t) : itemRow(m, t, it, i, keys))))
    .when(folded.length > 0, (el) => el.child(h_flex().pt(10).child(button(t, "l-more", m.allAgents ? "Fold the ones not installed" : `${folded.length} more, not installed here (${folded.filter((it) => !m.hidden.includes(it.key)).length} on)`,
      (_e, cx) => { m.allAgents = !m.allAgents; cx.notify(); }))));
}
