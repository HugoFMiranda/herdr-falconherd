// Herdr's status bar plus the focused conversation's account usage (5h / weekly), and the
// breakdown popup (this same mod opened as an overlay). See docs/2026-11-09-usage-branch-sidechat-design.md.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, shared, setShared, panes, terminals, focused, theme, run, exec, props, openOverlay, closeOverlay, nextCommand, home, readTextFile, hc, notify, watchFolder } from "herdr";
import { settingsOverlay, accounts, sessionAccount, machineColor, stateFile, isStale, formatTokens, levelOf, untilText, planLabel, fromCodexTokenCount, MODEL_CHOICES, EFFORT_LEVELS, switchTargets, switchKind, splitModels, modelKey, modelValue, modelLimit, modelSetRecently } from "./core.js";
import { sessionOf, readingsFor, parse, switchAccount, cacheRoot, readOn, helper, modelLists, typeCommand } from "./session.js";

const PROBE_MS = 5 * 60 * 1000;
// An effort picked with another model: { terminal, label, effort, at }. The menu puts /model in the
// input line; once the person sent it and Claude says it switched, this bar puts the effort there.
const PENDING = "falcon-status.pending";
const PENDING_MS = 15 * 60 * 1000;
// A menu pick for the bar to put in the input line: { id, terminal, text, label?, effortAfter?, busy }.
const SEND = "falcon-status.send";
const pad = (n) => String(n).padStart(2, "0");
const PLAN_MS = 5 * 60 * 1000;

// Plan names ("Team", "Max"): Claude's from its account file (only organizationType is kept).
async function claudePlan(s) {
  const a = accounts(s.machine).find((x) => x.id === s.account);
  if (!a) return null;
  return planLabel(parse(await readOn(`${s.home}/${stateFile(a)}`, s.machine))?.oauthAccount?.organizationType);
}

// Codex's newest limits, from its newest conversation log: { limits, plan } or null.
async function codexLatest(machine) {
  const r = await exec("sh", ["-c", 'f=$(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -1); [ -n "$f" ] && stat -c %Y "$f" && tail -n 400 "$f" | grep \'"token_count"\' | grep \'"used_percent"\' | tail -1'], machine ? { on: machine } : {}).catch(() => null);
  const [mtime, line] = (r?.stdout ?? "").split("\n");
  const ev = parse(line)?.payload;
  if (!ev) return null;
  return { limits: fromCodexTokenCount(ev, Number(mtime) * 1000).limits, plan: planLabel(ev.rate_limits?.plan_type) };
}

const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function openMarkdown(file) {
  // The Files panel's reader (formatted, follows changes; Browser for the full rendering).
  setShared("files.open", { file, at: Date.now() });
  run("layout.select", { stack: "panel-body", child: "files" });
  run("layout.show", { id: "panel" });
}

export default class StatusSession extends View {
  init(_props, cx) {
    this.session = null;
    this.readings = null;
    this.lastAgent = {};
    this.probed = {};
    this.popup = null;
    this.plans = {};       // account -> plan label, refreshed every 5 min
    this.plansAt = {};
    this.codex = null;     // Codex's newest limits, shown beside a Claude session
    const refresh = (cx) => cx.spawn(async (cx) => {
      const terminal = this.followed();
      const s = terminal ? await sessionOf(terminal) : null;
      const r = s ? await readingsFor(s) : null;
      this.session = s;
      this.readings = r;
      this.models = s ? await modelLists(s).catch(() => null) : null;
      const key = s ? `${s.machine ?? ""}:${s.account}` : null; // an account's plan and probe, per machine
      if (s?.tool === "claude" && Date.now() - (this.plansAt[key] ?? 0) > PLAN_MS) {
        this.plansAt[key] = Date.now();
        this.plans[key] = await claudePlan(s);
      }
      // Codex's plan name comes from its newest log; only needed for a Codex session.
      this.codex = s?.tool === "codex" ? await codexLatest(s.machine) : null;
      if (s?.tool === "claude" && !this.popupMode() && Date.now() - (this.probed[key] ?? 0) > PROBE_MS) {
        this.probed[key] = Date.now();
        const dir = accounts(s.machine).find((a) => a.id === s.account)?.dir;
        helper("claude-usage", [s.account, ...(dir ? [dir] : [])], s.machine, { timeout: 40000 }).catch(() => null);
      }
      cx.notify();
    });
    refresh(cx);
    cx.timer.every(5000, refresh);
    if (!this.popupMode()) {
      // Markdown files sent by the herdr-md-open helper (links clicked in a terminal). mv claims a
      // request, so a second Herdr window doesn't open it too.
      cx.timer.every(1000, (cx) => cx.spawn(async (cx) => this.followPending(cx)));
      // Herdr wakes this when a request lands (watchFolder); a slow check covers a missed wake.
      const dir = `${cacheRoot()}/md-open`;
      const claim = async () => {
        const r = await exec("sh", ["-c", 'for f in "$1"/*.req; do [ -f "$f" ] && mv "$f" "$f.$$" 2>/dev/null && cat "$f.$$" && echo && rm -f "$f.$$"; done', "sh", dir]).catch(() => null);
        for (const file of (r?.stdout ?? "").split("\n").filter(Boolean)) openMarkdown(file);
      };
      cx.spawn(async () => {
        await exec("sh", ["-c", 'mkdir -p "$1"', "sh", dir]).catch(() => null);
        await claim();
        for (;;) {
          if (!(await watchFolder(dir).then(() => true, () => false))) return;
          await claim();
        }
      });
      cx.timer.every(30000, (cx) => cx.spawn(async () => claim()));
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          if (c === "usage") this.toggle();
          cx.notify();
        }
      });
    }
  }

  // A pick from the menu (SEND): put in the conversation's input line here (typeCommand), for the
  // person's Enter. A model switch with an effort leaves PENDING for followPending.
  async sendRequest(req, cx) {
    if (shared(SEND)?.id === req.id) setShared(SEND, null);
    if (req.kind === "switch") return this.switchRequest(req);
    const r = await typeCommand(req.terminal, req.text, cx);
    if (r === "failed") notify({ title: "Couldn't type the command", body: req.text, level: "error", timeout: 6000 });
    else if (req.effortAfter) setShared(PENDING, { terminal: req.terminal, label: req.label, effort: req.effortAfter, at: Date.now() });
    return r;
  }

  // Continue a conversation on another account or tool (a new tab: copying the log, answering the
  // new folder's trust question take seconds), while the menu that asked is already closed.
  async switchRequest(req) {
    notify({ title: `Continuing on ${req.to.label}`, body: req.modelLabel ? `${req.modelLabel}${req.to.effort ? ` · ${req.to.effort}` : ""}` : "", level: "info", timeout: 3000 });
    const s = await sessionOf(req.terminal).catch(() => null);
    if (!s) { notify({ title: "That conversation is gone", level: "error", timeout: 5000 }); return; }
    await switchAccount(s, req.to).catch(() => notify({ title: "Switch didn't start", level: "error" }));
  }

  // The effort that goes with a model picked in the menu, put in the input line once Claude switched.
  async followPending(cx) {
    const p = shared(PENDING);
    if (!p || this.following) return;
    if (Date.now() - p.at > PENDING_MS) { setShared(PENDING, null); return; }
    this.following = true;
    try {
      if (!modelSetRecently((await hc(["read", p.terminal]).catch(() => null))?.stdout, p.label)) return;
      setShared(PENDING, null);
      await typeCommand(p.terminal, `/effort ${p.effort}`, cx);
    } finally {
      this.following = false;
    }
  }

  popupMode() { return Boolean(props()?.overlay); }
  menuMode() { return props()?.menu === "switch"; }

  // A switch target's models (modelLists: the account's own, else the built-in list).
  modelsOf(to) { return this.models?.[modelKey(to)] ?? MODEL_CHOICES[to.tool] ?? []; }

  // The model / account menu, opened from the model button. It pages instead of growing: the
  // account's current models, "Other models" for older versions, and one row per other account; a
  // model's › opens its efforts, an account's › its models. Sized once for its tallest page (a popup
  // keeps its size).
  openMenu() {
    const s = this.session;
    if (!s) return;
    const others = switchTargets(s.machine).filter((to) => switchKind(s, to) !== "same");
    const own = splitModels(this.modelsOf({ tool: s.tool, account: s.account }));
    // While Claude replies, a note under the heading says a change waits: room for it, so the last row shows.
    const busy = s.tool === "claude" && agents().find((a) => a.address === s.terminal)?.status === "working" ? 20 : 0;
    const main = 24 + busy + 26 * (own.main.length + (own.more.length ? 1 : 0)) + (others.length ? 24 + 26 * others.length : 0) + 7 + 26;
    const pages = [EFFORT_LEVELS.length, own.more.length, ...others.map((to) => splitModels(this.modelsOf(to)).main.length)];
    const sub = 26 + busy + 26 * Math.max(...pages);
    openOverlay({ mod: "falcon-status", kind: "popup", width: 270, height: Math.min(560, 12 + Math.max(main, sub) + 8), props: { menu: "switch" } });
  }

  modelLabel() {
    const m = this.readings?.model;
    const s = this.session;
    const lists = s ? [this.modelsOf({ tool: s.tool, account: s.account })] : [];
    const known = [...lists.flat(), ...MODEL_CHOICES.claude, ...MODEL_CHOICES.codex].find((x) => x.id === m?.id);
    return known?.label ?? m?.name ?? "Model";
  }

  renderMenu() {
    const t = theme();
    const s = this.session;
    const root = v_flex().size_full().p(6).gap(1).bg(t.popover).text_size(12).text_color(t.foreground);
    if (!s) return root.child(div().px(8).py(6).text_color(t.dim).child(this.busy ?? "No conversation in focus"));
    if (this.busy) return root.child(h_flex().px(8).py(6).gap(6).items_center().text_color(t.dim)
      .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900)).child(this.busy));
    const overlay = props().overlay;
    const current = this.readings?.model?.id;
    const effort = this.readings?.effort;
    // The pane header opens this menu on its account list ("accounts"); back leads there.
    const start = props()?.start === "accounts" ? { kind: "accounts" } : null;
    const page = this.page ?? start;
    const open = (next) => (cx) => { this.page = next; cx.notify(); };
    const head = (text) => div().px(8).h(24).flex().items_center().text_size(11).text_color(t.dim).child(text);
    const back = (label, to = null) => h_flex().id("menu-back").h(26).px(8).gap(6).items_center().rounded(6).cursor_pointer().text_color(t.muted)
      .hover((st) => st.bg(t.selected).text_color(t.foreground)).on_click((_e, cx) => open(to)(cx))
      .child(svg("mods/falcon-status/chevron-left.svg").size(11).flex_none()).child(label);
    // A row: a mark (✓, a color dot), its label, a dim hint, and › when it opens a page. The › is its
    // own target where the row does something else too (a model switches; its › picks the effort).
    const row = ({ id, mark, label, hint, action, more }) => h_flex().id(id).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((st) => st.bg(t.selected))
      .on_click((_e, cx) => (action ?? more)(cx))
      .child(div().w(12).flex_none().flex().items_center().text_color(t.accent).child(mark ?? ""))
      .child(div().flex_1().truncate().child(label))
      .when(Boolean(hint), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(hint)))
      .when(Boolean(more), (el) => el.child(div().id(`${id}-more`).flex_none().p(2).rounded(4).text_color(t.dim)
        .hover((st) => st.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); more(cx); })
        .child(svg("mods/falcon-status/chevron-right.svg").size(11))));
    const cap = (l) => l[0].toUpperCase() + l.slice(1);
    const own = splitModels(this.modelsOf({ tool: s.tool, account: s.account }));
    const busy = agents().find((a) => a.address === s.terminal)?.status === "working";
    // A pick: handed to the bar (SEND, sendRequest) and the popup closes on the click. Typing takes
    // ~0.7 s, and a closing popup would cancel it, so the bar, which stays, does it.
    const pick = (req) => () => {
      setShared(SEND, { ...req, terminal: s.terminal, busy, id: `${Date.now()}-${Math.random()}` });
      closeOverlay(overlay);
    };
    const busyNote = () => div().px(8).pb(4).text_size(10.5).text_color(t.dim).child("Claude is replying: a model change runs after it");

    // A model's efforts: picking one on another model switches both (/model, then /effort).
    if (page?.kind === "effort") {
      const m = page.model;
      return root.child(back(m.label, page.from)).when(busy && m.id !== current, (el) => el.child(busyNote())).children((m.efforts ?? EFFORT_LEVELS).map((l) => row({
        id: `e-${l}`, mark: m.id === current && l === effort ? "✓" : "", label: cap(l),
        action: pick(m.id !== current ? { text: `/model ${modelValue(m)}`, label: m.label, effortAfter: l } : { text: `/effort ${l}` }),
      })));
    }
    // A Claude model of this conversation's account (main page and Other models).
    const modelRow = (m, from) => row({
      id: `m-${m.id}`, mark: m.id === current ? "✓" : "", label: m.label,
      // Claude re-reads the whole conversation on another model (it asks first).
      hint: s.tool !== "claude" ? "" : m.id === current ? effort : "re-reads history",
      // Claude takes /model <short name> (its effort stays); Codex's /model opens its own picker in the pane.
      action: s.tool === "claude"
        ? (m.id !== current ? pick({ text: `/model ${modelValue(m)}`, label: m.label }) : () => closeOverlay(overlay))
        : pick({ text: "/model" }),
      more: s.tool === "claude" && (m.efforts ?? EFFORT_LEVELS).length > 0 ? open({ kind: "effort", model: m, from }) : null,
    });
    if (page?.kind === "more") return root.child(back("Other models", start)).children(own.more.map((m) => modelRow(m, page)));
    // Continuing on another account: handed to the bar (switchRequest), the menu closes on the click.
    const continueOn = (to, m, effortPick) => () => {
      setShared(SEND, { kind: "switch", terminal: s.terminal, id: `${Date.now()}-${Math.random()}`,
        modelLabel: m.label, to: { ...to, model: modelValue(m), effort: to.tool === "claude" ? effortPick : null } });
      closeOverlay(overlay);
    };
    // One of its models' efforts (Claude): the conversation continues there on both.
    if (page?.kind === "account-effort") {
      const { to, model: m } = page;
      return root.child(back(`${to.label} · ${m.label}`, { kind: "account", to })).children((m.efforts ?? EFFORT_LEVELS).map((l) => row({
        id: `ae-${l}`, mark: l === effort ? "•" : "", label: cap(l), hint: l === effort ? "as now" : "", action: continueOn(to, m, l),
      })));
    }
    // An account's models: the conversation continues there on the model picked, at its effort.
    if (page?.kind === "account") {
      const to = page.to;
      return root.child(back(to.label, start)).children(splitModels(this.modelsOf(to)).main.map((m) => row({
        id: `a-${to.tool}-${to.account}-${m.id}`, label: m.label, hint: to.tool === "claude" && effort ? effort : "",
        action: continueOn(to, m, effort),
        more: to.tool === "claude" && (m.efforts ?? EFFORT_LEVELS).length > 0 ? open({ kind: "account-effort", to, model: m }) : null,
      })));
    }
    const others = switchTargets(s.machine).filter((to) => switchKind(s, to) !== "same").map((to) => row({
      id: `t-${to.tool}-${to.account}`, label: to.label, hint: switchKind(s, to) === "account" ? "exact copy" : "handoff",
      mark: div().size(6).rounded(3).bg(accounts(s.machine).find((a) => a.id === to.account)?.color ?? t.foreground),
      more: open({ kind: "account", to }),
    }));
    if (page?.kind === "accounts") return root.child(head("Continue this conversation on")).children(others);
    const inMore = own.more.some((m) => m.id === current);
    return root.child(head("Model")).when(busy && s.tool === "claude", (el) => el.child(busyNote())).children(own.main.map((m) => modelRow(m, null)))
      .when(own.more.length > 0, (el) => el.child(row({ id: "m-more", mark: inMore ? "✓" : "", label: "Other models",
        hint: inMore ? own.more.find((m) => m.id === current).label : "", more: open({ kind: "more" }) })))
      .when(others.length > 0, (el) => el.child(head("Continue on another account")).children(others))
      .child(div().h(1).mx(8).my(3).bg(t.border))
      .child(row({ id: "m-settings", label: "Accounts…", action: () => {
        closeOverlay(overlay);
        openOverlay(settingsOverlay("accounts"));
      } }));
  }

  // The focused pane's agent, else the last agent focused in this tab.
  followed() {
    if (props()?.terminal) return props().terminal;
    const p = panes().find((x) => x.focused);
    if (p?.program?.agent && p.terminal) { this.lastAgent[p.tab] = p.terminal; return p.terminal; }
    const tab = focused()?.tab;
    const t = tab && this.lastAgent[tab];
    return t && panes().some((x) => x.terminal === t) ? t : null;
  }

  toggle() {
    if (this.popup) { closeOverlay(this.popup); this.popup = null; return; }
    const rows = (this.readings?.limits?.windows.length ?? 0) + (this.readings?.context ? 1 : 0);
    this.popup = openOverlay({ mod: "falcon-status", kind: "popup", width: 350, height: 48 + 27 * Math.max(1, rows) + (this.readings?.context ? 12 : 0) });
  }

  account() {
    const s = this.session;
    if (!s) return null;
    if (s.tool === "codex") {
      const c = sessionAccount(s);
      return { label: c?.label ?? "Codex", color: c?.color ?? theme().foreground, plan: this.codex?.plan ?? null };
    }
    const a = accounts(s.machine, "claude").find((x) => x.id === s.account);
    return a && { ...a, plan: this.plans[`${s.machine ?? ""}:${s.account}`] ?? null };
  }

  // Green under 50%, yellow from 50%, red from 80%.
  levelColor(t, pct) { return { ok: t.ansi2, warn: t.ansi3, high: t.ansi1 }[levelOf(pct)]; }

  bar(t, pct, w, h, dim = false) {
    return div().w(w).h(h).flex_none().rounded(h / 2).bg(t.border)
      .child(div().h(h).rounded(h / 2).bg(dim ? t.dim : this.levelColor(t, pct)).w(Math.max(0, Math.min(1, pct / 100)) * w));
  }

  // "5h ▬ 48% · 2h 10m": one limit, colored by how close it is, with time to reset.
  limit(t, label, w, stale, small = false) {
    const pct = Math.round(w.usedPercent);
    const left = untilText(w.resetsAt, Date.now());
    return h_flex().gap(5).items_center()
      .child(label)
      .when(!small, (el) => el.child(this.bar(t, w.usedPercent, 46, 4, stale)))
      .child(div().text_color(stale ? t.dim : this.levelColor(t, w.usedPercent)).child(`${pct}%`))
      .when(Boolean(left) && !small, (el) => el.child(div().text_color(t.dim).child(`· ${left}`)));
  }

  badge(t, text) {
    return div().flex_none().px(5).h(16).flex().items_center().rounded(4).bg(t.raised).text_size(10.5).text_color(t.accent).child(text);
  }

  gauge(t) {
    const acc = this.account();
    const lim = this.readings?.limits;
    if (!acc || !lim) return null;
    const stale = isStale(lim.at, Date.now());
    const pick = (l, id) => l?.windows.find((w) => w.id === id);
    return h_flex().id("usage").gap(10).items_center().cursor_pointer().text_color(stale ? t.dim : t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click(() => this.toggle())
      .child(h_flex().gap(5).items_center().child(div().size(6).rounded(3).bg(acc.color)).child(acc.label)
        .when(Boolean(acc.plan), (el) => el.child(this.badge(t, acc.plan))))
      .when(Boolean(pick(lim, "five_hour")), (el) => el.child(this.limit(t, "5h", pick(lim, "five_hour"), stale)))
      .when(Boolean(pick(lim, "seven_day")), (el) => el.child(this.limit(t, "wk", pick(lim, "seven_day"), stale)))
      // On a model with a weekly limit of its own (Fable), that one too, named by its family.
      .when(Boolean(modelLimit(lim, this.readings?.model?.id)), (el) => {
        const own = modelLimit(lim, this.readings.model.id);
        return el.child(this.limit(t, own.id.slice("seven_day_".length), own, stale));
      })
      .when(stale, (el) => el.child(`as of ${hhmm(lim.at)}`));
  }

  renderPopup() {
    const t = theme();
    const acc = this.account();
    const lim = this.readings?.limits;
    const ctx = this.readings?.context;
    const root = v_flex().size_full().p(12).gap(7).text_size(12).text_color(t.foreground).bg(t.popover);
    if (!acc || (!lim && !ctx)) return root.child(div().text_color(t.dim).child("No usage yet"));
    const session = lim?.windows.find((w) => w.id === "five_hour");
    const row = (label, pct, value, stale = false) => h_flex().gap(8).items_center().when(stale, (el) => el.text_color(t.dim))
      .child(div().w(104).flex_none().truncate().child(label))
      .child(div().flex_1().child(this.bar(t, pct, 96, 4, stale)))
      .child(div().w(96).flex_none().text_right().text_color(t.muted).child(value));
    return root
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().size(6).rounded(3).bg(acc.color))
        .child(`${acc.label}${acc.plan ? ` ${acc.plan}` : ""}${session?.resetsAt ? ` · resets ${hhmm(Date.parse(session.resetsAt))}` : ""}${lim && isStale(lim.at, Date.now()) ? ` · as of ${hhmm(lim.at)}` : ""}`))
      .children((lim?.windows ?? []).map((w) => {
        const stale = isStale(w.at ?? lim.at, Date.now());
        const left = untilText(w.resetsAt, Date.now());
        return row(w.label, w.usedPercent, stale ? `${Math.round(w.usedPercent)}% · ${hhmm(w.at ?? lim.at)}` : left ? `${Math.round(w.usedPercent)}% · ${left}` : `${Math.round(w.usedPercent)}%`, stale);
      }))
      .when(Boolean(ctx), (el) => el
        .child(div().h(1).my(2).bg(t.border))
        .child(row("Context", ctx.percent, `${formatTokens(ctx.used)} / ${formatTokens(ctx.size)}`)));
  }

  render(cx) {
    // A pick handed over by the menu: sent once, from this bar (sendRequest).
    const req = this.popupMode() ? null : shared(SEND);
    if (req && req.id !== this.sentId) {
      this.sentId = req.id;
      cx.spawn(async (cx) => this.sendRequest(req, cx));
    }
    if (this.menuMode()) return this.renderMenu();
    if (this.popupMode()) return this.renderPopup();
    const t = theme();
    const space = spaces().find(s => s.active);
    // Agents in settled tabs (snoozed ones are settled too) count as away, not as needing you.
    const settledTabs = new Set(spaces().flatMap((sp) => sp.tabs).filter((tab) => tab.settled).map((tab) => tab.id));
    const snoozed = shared("falcon-agents.snoozed") ?? {};
    const all = agents(), list = all.filter((a) => !settledTabs.has(a.tab) && !snoozed[a.address]), away = all.length - list.length;
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const gauge = this.gauge(t);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(space?.machine ? label("server", space.machine).text_color(machineColor(space.machine)) : label("monitor", "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} ${list.length === 1 ? "agent" : "agents"}`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`)))
        .when(away > 0, el => el.child(div().text_color(t.dim).child(`· ${away} away`))))
      .child(div().flex_1())
      .when(Boolean(this.session), el => el.child(h_flex().id("model").gap(4).items_center().cursor_pointer().px(6).h(20).rounded(5)
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        // No tooltip: the pointer rests here while the menu is open, and it covered the menu's last row.
        .on_click(() => this.openMenu())
        .child(this.modelLabel())
        .when(this.session?.tool === "claude" && Boolean(this.readings?.effort), (el) => el.child(div().text_color(t.dim).child(`· ${this.readings.effort}`)))
        .child(svg("mods/workspace-chrome/chevron-down.svg").size(10))))
      .when(Boolean(gauge), el => el.child(gauge));
  }
}
