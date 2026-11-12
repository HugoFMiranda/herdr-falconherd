// Accounts: each account of an agent or program on this computer (Claude Code, Codex, Gemini, any
// other): its command, its config folder (how Claude and Codex conversations are matched; optional for
// the others, matched by command), and the color and icon its tabs and conversations show.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { accountProblems, accountId, accountTitle, accountTool, toolInfo, toolOf, ACCOUNT_COLORS, TOOLS, glyphsFor, foundAccounts } from "./core.js";
import { headingRow, about, note, button, chip, row, title, field, swatch, pic, iconChoice, form, label, problems } from "./ui.js";
import { changed, status, findAccounts } from "./store.js";

const HEX = /^#[0-9a-fA-F]{6}$/;
const OTHER = "other";
const slug = (name) => (name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// The tools to pick from: Claude, Codex, the other agents Herdr knows that are installed here, and
// any other program (named in the form).
function toolChoices(m) {
  // knownAgents also lists the + menu's own entries (programs.json): those aren't tools.
  const ownEntry = (key) => m.launchers.some((l) => l.id === key) || m.baseRun.includes(key);
  const others = m.agents.filter((a) => a.installed && !TOOLS[a.key] && !ownEntry(a.key)).map((a) => ({ id: a.key, name: a.name, icon: a.icon, tint: a.tint }));
  return [...Object.values(TOOLS).map((x) => ({ id: x.id, name: x.name, icon: x.glyph, tint: true })), ...others];
}
const agentOf = (m, tool) => m.agents.find((a) => a.key === tool) ?? null;

// What a new account of a tool starts with.
function fresh(m, tool, name = null) {
  const info = toolInfo(tool, name ?? agentOf(m, tool)?.name);
  const agent = agentOf(m, tool);
  return {
    tool, toolName: info.known ? undefined : info.name, label: "",
    dir: info.known ? `${info.dir}_` : "",
    bin: info.known ? info.bin : agent?.run?.[0] ?? tool,
    color: ACCOUNT_COLORS[m.list.length % ACCOUNT_COLORS.length],
    icon: info.known ? info.glyph : agent?.tint ? agent.icon : "mods/falcon-accounts/glyphs/terminal.svg",
  };
}

// found: a folder found in home ({ tool, dir, label, bin }), to start a new account from.
function edit(m, index, cx, found = null) {
  const a = index == null ? { ...fresh(m, found?.tool ?? "claude"), ...(found ?? {}) } : m.list[index];
  m.inputs = {
    label: InputState.new({ value: a.label, placeholder: "Work, Personal, Client…" }),
    dir: InputState.new({ value: a.dir ?? "", placeholder: `${accountTool(a).dir ?? `.${toolOf(a)}`}_work` }),
    bin: InputState.new({ value: a.bin, placeholder: accountTool(a).bin }),
    hex: InputState.new({ value: a.color, placeholder: "#rrggbb" }),
    program: InputState.new({ value: "", placeholder: "Aider, my-agent…" }),
  };
  // The form names the program as it's typed.
  m.inputs.program.on("change", (_e, cx) => cx.notify());
  m.editing = { section: "accounts", kind: "account", index, tool: toolOf(a), toolName: a.toolName, other: false, color: a.color, icon: a.icon, problems: [] };
  cx.notify();
}

// A new account's tool: its folder, command and icon follow, unless they were changed.
function pickTool(m, tool, cx) {
  const e = m.editing;
  const otherStart = { ...fresh(m, "program"), dir: "", bin: "", icon: "mods/falcon-accounts/glyphs/terminal.svg" };
  const was = e.other ? otherStart : fresh(m, e.tool, e.toolName);
  const next = tool === OTHER ? otherStart : fresh(m, tool);
  const dir = m.inputs.dir.value() === was.dir ? next.dir : m.inputs.dir.value();
  const bin = m.inputs.bin.value() === was.bin ? next.bin : m.inputs.bin.value();
  // Placeholders can't change: new inputs, with the tool's.
  const info = tool === OTHER ? null : toolInfo(tool);
  m.inputs.dir.release();
  m.inputs.bin.release();
  m.inputs = {
    ...m.inputs,
    dir: InputState.new({ value: dir, placeholder: info?.known ? `${info.dir}_work` : "none" }),
    bin: InputState.new({ value: bin, placeholder: info?.known ? info.bin : "my-agent --flag" }),
  };
  m.editing = { ...e, tool: tool === OTHER ? e.tool : tool, toolName: next.toolName, other: tool === OTHER, icon: e.icon === was.icon ? next.icon : e.icon };
  cx.notify();
}

const shownColor = (m) => { const typed = m.inputs?.hex.value().trim(); return HEX.test(typed ?? "") ? typed : m.editing.color; };

// The form's tool: picked, or (Other) the program named, as an id and a name.
function formTool(m) {
  const e = m.editing;
  if (!e.other) return { tool: e.tool, toolName: TOOLS[e.tool] ? undefined : e.toolName ?? agentOf(m, e.tool)?.name };
  const name = m.inputs.program.value().trim();
  return { tool: slug(name) || "", toolName: name };
}

function done(m, cx) {
  const e = m.editing;
  const others = m.list.filter((_, i) => i !== e.index);
  const v = m.inputs;
  const { tool, toolName } = formTool(m);
  const dir = v.dir.value().trim();
  const draft = { tool, ...(toolName ? { toolName } : {}), label: v.label.value().trim(), ...(dir ? { dir } : { dir: null }), bin: v.bin.value().trim(), color: shownColor(m), icon: e.icon };
  const found = accountProblems(draft, others);
  if (found.length) { m.editing = { ...e, problems: found }; cx.notify(); return; }
  const id = e.index == null ? accountId(draft.label, others.map((a) => a.id)) : m.list[e.index].id;
  const account = { id, ...draft };
  m.list = e.index == null ? [...m.list, account] : m.list.map((a, i) => (i === e.index ? account : a));
  m.editing = null;
  changed(m, cx);
}

// A removed account's + menu entries keep its icon, as their own.
function remove(m, i, cx) {
  const gone = m.list[i];
  m.list = m.list.filter((_, j) => j !== i);
  m.launchers = m.launchers.map((l) => (l.account === gone.id ? { ...l, account: null, icon: gone.icon, tint: true } : l));
  changed(m, cx);
}

function toolPicker(m, t, e) {
  const option = (id, text, icon, chosen, onClick) => h_flex().id(id).h(28).px(10).gap(7).items_center().rounded(7).cursor_pointer().text_size(12.5)
    .border_1().border_color(chosen ? t.accent : t.border).bg(chosen ? t.background : t.raised).text_color(chosen ? t.foreground : t.muted)
    .hover((s) => s.text_color(t.foreground)).on_click(onClick).when(Boolean(icon), (el) => el.child(icon)).child(text);
  return h_flex().gap(6).flex_wrap()
    .children(toolChoices(m).map((c) => option(`acc-tool-${c.id}`, c.name, c.icon ? pic(c.icon, 14, c.tint ? t.foreground : null) : null,
      !e.other && e.tool === c.id, (_e, cx) => pickTool(m, c.id, cx))))
    .child(option("acc-tool-other", "Another program…", null, e.other, (_e, cx) => pickTool(m, OTHER, cx)));
}

function accountForm(m, t) {
  const e = m.editing;
  const { tool: toolId, toolName } = formTool(m);
  const tool = toolInfo(toolId || "program", toolName || "this program");
  const color = shownColor(m);
  const agent = agentOf(m, toolId);
  const own = agent?.tint ? [{ path: agent.icon, label: agent.name }] : [];
  const glyphs = glyphsFor(toolId, own);
  const icons = glyphs.some((g) => g.path === e.icon) ? glyphs : [{ path: e.icon, label: "Current" }, ...glyphs];
  const known = tool.known;
  const folder = field(t, known ? "Config folder in home" : "Config folder in home (if it has one)", m.inputs.dir, { mono: true });
  return form(t, "acc-form")
    .child(div().text_size(14).font_semibold().child(e.index == null ? "New account" : `Edit ${accountTitle(m.list[e.index])}`))
    .when(e.index == null, (el) => el.child(v_flex().gap(6).child(label(t, "For")).child(toolPicker(m, t, e))
      .when(e.other, (f) => f.child(field(t, "Program", m.inputs.program, { grow: false })))))
    .child(h_flex().gap(10).child(field(t, "Name", m.inputs.label)).child(known ? folder : field(t, "Command", m.inputs.bin, { mono: true })))
    .child(known
      ? v_flex().gap(5).child(field(t, `Command that starts ${tool.name} on it`, m.inputs.bin, { mono: true, grow: false }))
        .child(note(t, `Used to fork, switch to and resume conversations. ${tool.bin} for ~/${tool.dir}; for another folder, a wrapper that sets ${tool.env} (like ${tool.example}). Its flags (skipping permissions, say) come from the conversation; the + menu's own commands are in + menu.`))
      : v_flex().gap(5).child(folder)
        .child(note(t, `Herdr can't see inside ${tool.name} which account it's on, so it goes by the command: tabs started with it (from the + menu, say) show this account. With one account for ${tool.name}, all its tabs do. Forks, switches and usage are Claude and Codex only.`)))
    .child(v_flex().gap(6).child(label(t, "Color"))
      .child(h_flex().gap(8).items_center()
        .children(ACCOUNT_COLORS.map((c) => swatch(t, `acc-color-${c}`, c, color === c, (_e, cx) => { m.editing = { ...m.editing, color: c }; m.inputs.hex.set_value(c); cx.notify(); })))
        .child(Input.new(m.inputs.hex).w(96).h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.background)
          .text_size(12).font_family("JetBrains Mono").text_color(t.foreground))))
    .child(v_flex().gap(6).child(label(t, "Icon"))
      .child(h_flex().gap(4).flex_wrap().children(icons.map((g, i) => iconChoice(t, `acc-icon-${i}`, g.path, color, e.icon === g.path,
        (_e, cx) => { m.editing = { ...m.editing, icon: g.path }; cx.notify(); }, g.label)))))
    .when(e.problems.length > 0, (el) => el.child(problems(t, e.problems)))
    .child(h_flex().gap(8).justify_end()
      .child(button(t, "acc-form-cancel", "Cancel", (_e, cx) => { m.editing = null; cx.notify(); }))
      .child(button(t, "acc-form-done", e.index == null ? "Add account" : "Save", (_e, cx) => done(m, cx), { primary: true })));
}

function accountRow(m, t, a, i) {
  const busy = Boolean(m.editing);
  const tool = accountTool(a);
  const uses = m.launchers.filter((l) => l.account === a.id).length;
  // Claude and Codex keep one account each (the session features need one).
  const lastOfTool = tool.known && m.list.filter((x) => toolOf(x) === toolOf(a)).length < 2;
  return row(t, `acc-${a.id}`, {
    icon: pic(a.icon, 20, a.color),
    title: title(t, a.label, [chip(t, tool.name, a.color), ...(uses ? [chip(t, `${uses} in the + menu`)] : [])]),
    sub: [a.dir ? `~/${a.dir}` : null, a.bin].filter(Boolean).join(" · "),
    controls: [
      button(t, `acc-edit-${a.id}`, "Edit", (_e, cx) => edit(m, i, cx), { disabled: busy }),
      button(t, `acc-remove-${a.id}`, "Remove", (_e, cx) => remove(m, i, cx), { disabled: busy || lastOfTool }),
    ],
  });
}

// Looking for accounts: only when asked (Find). Then the Claude and Codex folders in home that aren't
// accounts yet, each a click from the form filled in; or that there's nothing new.
function foundRows(m, t) {
  if (m.editing) return [];
  // Ones added since the search drop out.
  const found = (m.found ?? []).filter((f) => !m.list.some((a) => a.dir === f.dir));
  const find = button(t, "acc-find", m.finding ? "Looking…" : m.found ? "Look again" : "Find accounts",
    (_e, cx) => findAccounts(m, cx), { disabled: m.finding || Boolean(m.error) });
  const head = h_flex().w_full().pt(18).gap(10).items_center()
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(label(t, m.found && found.length ? "Found on this computer, not accounts yet" : "Other accounts here"))
      .child(note(t, m.findError ?? (m.found && !found.length
        ? "Nothing new: every Claude and Codex folder in your home is an account already."
        : m.found ? "Add opens the form filled in; check the command before saving." : "Looks for Claude and Codex config folders in your home (.claude_*, .codex_*) that aren't accounts yet."),
        m.findError ? t.blocked : null)))
    .child(find);
  return [head, ...found.map((f) => row(t, `found-${f.dir}`, {
      icon: pic(TOOLS[f.tool].glyph, 18, t.dim), compact: true,
      title: title(t, f.label, [chip(t, TOOLS[f.tool].name)]),
      sub: `~/${f.dir}`,
      controls: [button(t, `found-add-${f.dir}`, "Add", (_e, cx) => edit(m, null, cx, f), { disabled: Boolean(m.error) })],
    }))];
}

export function accountsSection(m, t) {
  const e = m.editing?.kind === "account" ? m.editing : null;
  return v_flex().w_full()
    .child(headingRow(t, "Accounts", button(t, "acc-add", "Add account", (_e, cx) => edit(m, null, cx), { primary: true, disabled: Boolean(m.editing || m.error) })))
    .child(about(t, "Your accounts on this computer, for any agent or program. Their tabs and conversations show the account's color and icon: tabs, pane headers, the agents list, the status bar and the + menu. Claude Code and Codex conversations are matched by their config folder, and can fork, switch and resume; the others by the command they started with."))
    .child(status(m, t))
    .when(Boolean(e && e.index == null), (el) => el.child(accountForm(m, t)))
    .children(m.list.map((a, i) => (e && e.index === i ? accountForm(m, t) : accountRow(m, t, a, i))))
    .children(foundRows(m, t));
}
