// Which conversation runs in a terminal, and its usage readings.
// Copied into the mods that need it (mods can't import each other); its source is the status bar's.
// A terminal on another machine ("devbox/t3") is read there: its home, its Claude files, its helpers.
import { svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { hc, exec, home, appHome, readTextFile, writeTextFile, openOverlay, panes, spaces, notify, window, run, terminals, shared } from "herdr";
import { accounts, setAccounts, accountsFrom, setMachineLooks, titleSettings, promptsFrom, machineColor, PROFILE_SAVED, codexAccountOf, accountTitle, programAccount, switchTargets, modelKey, MODEL_CHOICES, keysFor, descendants, splitCommandLine, machineOf, fromStatusline, fromCodexTokenCount, newest, subagentsFrom, projectSlug, switchKind, switchArgv, loginShell } from "./core.js";

export const cacheRoot = () => `${home()}/.cache/herdr-session`;
export const parse = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
const on = (machine) => (machine ? { on: machine } : {});
export const readOn = (path, machine = null) => readTextFile(path, on(machine)).catch(() => null);
// args: $1, $2 … in the script (paths never go into the script text).
const sh = async (script, machine = null, args = []) => (await exec("sh", ["-c", script, "sh", ...args], on(machine)).catch(() => ({ stdout: "" }))).stdout;
// A helper program: here by name; elsewhere through a login shell, whose PATH has ~/.local/bin.
export const helper = (name, args, machine = null, opts = {}) => (machine
  ? exec("bash", ["-lc", 'exec "$@"', "bash", name, ...args], { ...opts, on: machine })
  : exec(name, args, opts));
const accountOf = (id, machine = null) => accounts(machine).find((a) => a.id === id);
// Terminals elsewhere are Unix (Herdr's remote machines); here, whatever this computer is.
export const platformOf = (machine) => (machine ? "linux" : window()?.platform);

// Each machine's home, asked once it answers (a machine still connecting is asked again next time).
const homes = new Map();
export const homeOn = (machine = null) => {
  if (!machine) return Promise.resolve(home());
  if (!homes.has(machine)) {
    homes.set(machine, sh('printf %s "$HOME"', machine).then((h) => {
      if (!h) homes.delete(machine);
      return h || null;
    }));
  }
  return homes.get(machine);
};

// A machine's Claude accounts (once per machine and mod): its Herdr home's gitignored `machine` file
// names a profile, machines/<profile>.json lists them. Elsewhere that home is ~/.config/herdr-app (a
// clone of this repo for the helpers). Without either, the work + personal defaults, looked for again
// after a minute (a profile installed later shows up without a reload).
const RETRY_MS = 60000;
// This computer's is read again as soon as the settings page saved it (PROFILE_SAVED).
const loaded = new Map(); // machine -> { promise, found, at, saved }
// Whether tabs and the agents list get titles from Claude Haiku (Settings → Titles), as last read.
let titles = titleSettings(null);
export const titlesOn = () => titles;

export const loadAccounts = (machine = null) => {
  const was = loaded.get(machine);
  const saved = machine ? null : shared(PROFILE_SAVED) ?? null;
  if (was && was.saved === saved && (was.found || Date.now() - was.at < RETRY_MS)) return was.promise;
  const entry = { found: false, at: Date.now(), saved };
  entry.promise = (async () => {
    const root = machine ? `${await homeOn(machine)}/.config/herdr-app` : appHome();
    const profile = (await readOn(`${root}/machine`, machine))?.trim();
    const file = /^[A-Za-z0-9_-]+$/.test(profile ?? "") ? parse(await readOn(`${root}/machines/${profile}.json`, machine)) : null;
    entry.found = Boolean(file);
    setAccounts(accountsFrom(file), machine);
    if (!machine) { setMachineLooks(file?.machines); titles = titleSettings(file); }
  })();
  loaded.set(machine, entry);
  return entry.promise;
};

// Another machine, as everything of it is marked: its server icon (and name) in its color.
export const machineBadge = (t, machine, { label = true } = {}) => {
  const c = machineColor(machine);
  return h_flex().flex_none().h(18).px(label ? 6 : 3).gap(4).items_center().rounded(5)
    .border(1).border_color(c + "40").bg(c + "17").text_size(10.5).text_color(c)
    .child(svg("mods/workspace-chrome/server.svg").size(11).flex_none())
    .when(label, (el) => el.child(machine));
};

// Windows only: every process as { pid, ppid, name, cmd } (cmd for Claude and Codex), shared for a few seconds.
const PROCS_MS = 3000;
const PROCS_PS = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | ForEach-Object { $c = if ($_.Name -in 'claude.exe', 'codex.exe') { $_.CommandLine } else { '' }; \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$c\" }";
let procs = { at: 0, list: null };
let procsAsked = null; // the scan under way: everyone asking meanwhile waits for that one
async function processTable() {
  if (procs.list && Date.now() - procs.at < PROCS_MS) return procs.list;
  if (procsAsked) return procsAsked;
  procsAsked = (async () => {
    const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", PROCS_PS]).catch(() => null);
    const list = (r?.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, ppid, name, cmd] = line.split("\t");
      return { pid: Number(pid), ppid: Number(ppid), name, cmd };
    });
    procs = { at: Date.now(), list };
    return list;
  })().finally(() => { procsAsked = null; });
  return procsAsked;
}

// Windows: shell pid -> the Claude under it ({ pid, argv }), or { at } when there was none then.
const claudeUnder = new Map();
const NONE_MS = 15000;

// The Claude session whose process is pid, on any of the machine's accounts, or null.
async function claudeSessionAt(pid, machine, h) {
  for (const a of accounts(machine, "claude")) {
    const s = parse(await readOn(`${h}/${a.dir}/sessions/${pid}.json`, machine));
    if (s?.sessionId) return { account: a.id, sessionId: s.sessionId, name: s.name ?? null };
  }
  return null;
}

// Another program's account for a terminal (Gemini, OpenCode…): by the command it started with, else
// its program's only account. programKey: what Herdr says runs there (pane.program.key).
export const terminalAccount = (terminal, programKey = null) => (terminal
  ? programAccount({ argv: terminals().find((x) => x.address === terminal)?.argv ?? [], programKey, machine: machineOf(terminal) })
  : null);

// A terminal as `hc get` describes it (foreground, labels, state). Herdr keeps every core terminal
// live in terminals(), so that's asked first; hc get (a process each time) only for one not there.
export async function terminalFacts(address) {
  const known = terminals().find((x) => x.address === address);
  if (known) return known;
  const r = await hc(["get", address]).catch(() => null);
  return r?.code === 0 ? parse(r.stdout) : null;
}

// { tool, account, sessionId, name, pid, argv, labels, terminal, machine, home, cache, rollout? } or null.
// machine is null here; home and cache are that machine's home and ~/.cache/herdr-session.
export async function sessionOf(terminal) {
  const t = await terminalFacts(terminal);
  const fg = t?.foreground;
  if (!fg?.pid) return null;
  const machine = machineOf(terminal);
  await loadAccounts(); // this computer's profile also picks machine colors
  if (machine) await loadAccounts(machine);
  const h = await homeOn(machine);
  if (!h) return null;
  const base = { terminal, pid: fg.pid, argv: fg.argv ?? [], labels: t.labels ?? {}, machine, home: h, cache: `${h}/.cache/herdr-session` };
  const own = await claudeSessionAt(fg.pid, machine, h);
  if (own) return { ...base, tool: "claude", ...own };
  if (!machine && window()?.platform === "windows") {
    // The Claude under this shell, remembered while its session file is there (asking Windows for
    // the process table means a PowerShell each time): asked again only for a new one.
    const known = claudeUnder.get(fg.pid);
    if (known?.pid) {
      const s = await claudeSessionAt(known.pid, null, h);
      if (s) return { ...base, pid: known.pid, argv: known.argv, tool: "claude", ...s };
      claudeUnder.delete(fg.pid);
    } else if (known && Date.now() - known.at < NONE_MS) return null;
    for (const p of descendants(await processTable(), fg.pid).filter((x) => x.name === "claude.exe")) {
      const s = await claudeSessionAt(p.pid, null, h);
      if (s) {
        claudeUnder.set(fg.pid, { pid: p.pid, argv: splitCommandLine(p.cmd) });
        return { ...base, pid: p.pid, argv: splitCommandLine(p.cmd), tool: "claude", ...s };
      }
    }
    claudeUnder.set(fg.pid, { at: Date.now() });
    return null; // Codex's log is found through /proc, which Windows doesn't have
  }
  if (fg.name === "codex" || /(^|\/)codex$/.test(fg.argv?.[0] ?? "")) {
    // The rollout log the codex process (or its child) has open.
    const pids = [fg.pid, ...(await sh(`pgrep -P ${fg.pid}`, machine)).split("\n").filter(Boolean)];
    let rollout = "";
    for (const pid of pids) {
      rollout = (await sh(`ls -l /proc/${pid}/fd 2>/dev/null | grep -o '/[^ ]*rollout-[^ ]*\\.jsonl' | head -1`, machine)).trim();
      if (rollout) break;
    }
    if (!rollout) return null;
    const id = parse((await sh('head -n 1 "$1"', machine, [rollout])).trim())?.payload?.id;
    return id ? { ...base, tool: "codex", account: codexAccountOf(rollout, h, machine), sessionId: id, name: null, rollout } : null;
  }
  return null;
}

// { limits, context }: limits are the account's newest reading, context is this session's own.
export async function readingsFor(s) {
  const m = s.machine;
  if (s.tool === "claude") {
    const own = parse(await readOn(`${s.cache}/claude/${s.sessionId}.json`, m));
    // The account's newest status line reading: statusline-save.sh keeps it in one file. Without
    // that file (a machine not updated yet), the newest sessions' readings are searched.
    const latest = parse(await readOn(`${s.cache}/accounts/claude-${s.account}.latest.json`, m));
    const lines = latest ? [fromStatusline(latest.statusline ?? {}, latest.at).limits] : [];
    if (!latest) {
      const files = (await sh('ls -t "$1"/claude/*.json 2>/dev/null | head -20', m, [s.cache])).split("\n").filter(Boolean);
      for (const f of files) {
        const d = parse(await readOn(f, m));
        if (d?.account === s.account) lines.push(fromStatusline(d.statusline ?? {}, d.at).limits);
      }
    }
    const account = parse(await readOn(`${s.cache}/accounts/claude-${s.account}.json`, m));
    return {
      limits: newest([account, ...lines]),
      context: own ? fromStatusline(own.statusline ?? {}, own.at).context : null,
      title: own?.title ?? null,
      model: own?.model ?? null,
      effort: own?.effort ?? null,
    };
  }
  const line = (await sh(`tail -n 400 "$1" | grep '"token_count"' | grep '"used_percent"' | tail -1`, m, [s.rollout])).trim();
  const at = Number((await sh('stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"', m, [s.rollout])).trim()) * 1000 || Date.now();
  const ev = parse(line);
  const model = (await sh(`grep -o '"model":"[^"]*"' "$1" | tail -1`, m, [s.rollout])).trim().replace(/^"model":"|"$/g, "") || null;
  return { ...fromCodexTokenCount(ev?.payload ?? ev, at), title: null, model: model ? { id: model, name: model } : null };
}

// Puts a command in a terminal's input line for the person to send with Enter, and the keyboard
// there. Pasted in one go when the clipboard holds text (Herdr pastes at once; hc's keys wait for the
// person to be quiet ~3 s, and type ~27 ms a key), the clipboard put back right after; typed with
// hc keys otherwise (an image there couldn't be put back). Claude's grey suggestion goes away when
// text arrives. "typed" or "failed".
export async function typeCommand(terminal, text, cx) {
  run("pane.focus", { terminal });
  const was = cx?.read_from_clipboard();
  if (was !== undefined) {
    cx.write_to_clipboard(text);
    run("terminal.paste");
    // The paste runs a moment later: the clipboard goes back once the command shows in the input line
    // (or after a second), never before.
    const shown = async () => ((await hc(["read", terminal]).catch(() => null))?.stdout ?? "").split("\n").filter((l) => l.includes("❯")).pop()?.includes(text);
    for (let i = 0; i < 12 && !(await shown()); i++) await pause(100);
    cx.write_to_clipboard(was);
    return "typed";
  }
  const keys = keysFor(text);
  if (!keys) return "failed";
  return (await hc(["keys", terminal, ...keys]).catch(() => null))?.code === 0 ? "typed" : "failed";
}

// The models each menu row can pick, by modelKey: the conversation's own account and every account it
// can move to, as claude-usage last saved them on that machine (else the built-in list).
export async function modelLists(s) {
  const out = {};
  for (const to of [{ tool: s.tool, account: s.account }, ...switchTargets(s.machine)]) {
    const key = modelKey(to);
    if (out[key]) continue;
    const saved = to.tool === "claude" ? parse(await readOn(`${s.cache}/accounts/claude-${to.account}.models.json`, s.machine)) : null;
    out[key] = Array.isArray(saved) && saved.length ? saved : MODEL_CHOICES[to.tool] ?? [];
  }
  return out;
}

// A Claude session's own sub-agents (its Agent tool): no terminals, but Claude records each one in
// <config>/projects/*/<session>/subagents/. { all: true } keeps finished ones of any age.
export async function subagentsOf(s, opts = {}) {
  const dir = accountOf(s?.account, s?.machine)?.dir;
  if (s?.tool !== "claude" || !dir || !/^[0-9a-f-]+$/.test(s.sessionId)) return [];
  const r = await exec("sh", ["-c", 'for f in "$1"/projects/*/"$2"/subagents/*.jsonl; do [ -f "$f" ] && { stat -c "%Y %n" "$f" 2>/dev/null || stat -f "%m %N" "$f"; }; done', "sh", `${s.home}/${dir}`, s.sessionId], on(s.machine)).catch(() => null);
  const entries = [];
  for (const line of (r?.stdout ?? "").split("\n").filter(Boolean).slice(-50)) {
    const sp = line.indexOf(" ");
    const jsonl = line.slice(sp + 1);
    const meta = parse(await readOn(jsonl.replace(/\.jsonl$/, ".meta.json"), s.machine));
    entries.push({ id: jsonl.split("/").pop().replace(/^agent-|\.jsonl$/g, ""), meta, at: Number(line.slice(0, sp)) * 1000, jsonl });
  }
  const byId = new Map(entries.map((e) => [e.id, e.jsonl]));
  return subagentsFrom(entries, Date.now(), opts).map((x) => ({ ...x, jsonl: byId.get(x.id), machine: s.machine, cache: s.cache }));
}

// Its task and latest output, as markdown in a floating falcon-md window.
// Resolves once the window is open: a popup that calls this must wait before closing itself,
// since closing a popup cancels its unfinished tasks. One on another machine is written there and
// copied here, since falcon-md reads files on this computer.
export async function openSubagent(x) {
  const out = `${cacheRoot()}/subagents/${x.id}.md`;
  if (x.machine) {
    const there = `${x.cache}/subagents/${x.id}.md`;
    const r = await helper("claude-subagent-md", [x.jsonl, there], x.machine).catch(() => null);
    const text = r?.code === 0 ? await readOn(there, x.machine) : null;
    if (text == null) return false;
    await exec("sh", ["-c", 'mkdir -p "$(dirname "$1")" && rm -f "$1"', "sh", out]).catch(() => null);
    await writeTextFile(out, text, null).catch(() => null);
  } else {
    const r = await exec("claude-subagent-md", [x.jsonl, out]).catch(() => null);
    if (r?.code !== 0) return false;
  }
  openOverlay({ kind: "window", key: `falcon-md:${out}`, mod: "falcon-md", props: { file: out } });
  return true;
}

// Whether a conversation has anything to copy: Claude writes a session's log only once its first
// message is sent, so a fresh one can't be forked, side-chatted or moved yet (--resume finds nothing).
export async function hasConversation(s) {
  return Boolean(s?.tool === "codex" ? s.rollout : await claudeLog(s));
}
export const notifyEmpty = () => notify({ title: "Nothing to copy yet", body: "This conversation has no messages: send one first", level: "warning", timeout: 5000 });

// Claude's log of a session, wherever its project folder is.
async function claudeLog(s) {
  const dir = accountOf(s.account, s.machine)?.dir;
  const r = await exec("sh", ["-c", 'for f in "$1"/projects/*/"$2".jsonl; do [ -f "$f" ] && echo "$f" && break; done', "sh", `${s.home}/${dir}`, s.sessionId], on(s.machine)).catch(() => null);
  return r?.stdout.trim() || null;
}

// A Claude conversation's typed prompts: { count, recent } (count: its user entries that aren't tool
// results, about how many messages were typed; recent: the last three typed ones). Only user lines
// are read (a log's other lines can be megabytes of tool output).
export async function recentPrompts(s) {
  if (s?.tool !== "claude") return null;
  const log = await claudeLog(s);
  if (!log) return null;
  // One pass: user lines that aren't tool results, meta lines or slash commands; their count first,
  // then the last 40 of them.
  const script = 'grep -F \'"type":"user"\' "$1" | grep -vF -e \'"type":"tool_result"\' -e \'"isMeta":true\' -e \'<command-\' | awk \'{ n++; last[n % 40] = $0 } END { print n + 0; for (i = n - 39; i <= n; i++) if (i > 0) print last[i % 40] }\'';
  const r = await exec("sh", ["-c", script, "sh", log], on(s.machine)).catch(() => null);
  if (r?.code !== 0) return null;
  const [first, ...lines] = r.stdout.split("\n");
  const recent = promptsFrom(lines).slice(-3);
  return { count: Math.max(Number(first.trim()) || 0, recent.length), recent };
}

const pause = (ms) => exec("sleep", [String(ms / 1000)]).catch(() => null);

// Continue a conversation on another account, in a new tab: the other Claude account gets an exact
// copy of the log; another tool gets the conversation as a markdown handoff. The original stays.
// All of it on the conversation's own machine.
export async function switchAccount(s, to) {
  const kind = switchKind(s, to);
  if (kind === "same") return;
  const m = s.machine;
  const p = panes().find((x) => x.terminal === s.terminal);
  let handoffFile = null;
  if (kind === "account") {
    // Into the other account, under its folder name and under where the copy starts.
    const log = await claudeLog(s);
    if (!log) { notifyEmpty(); return; }
    const toDir = `${s.home}/${accountOf(to.account, m).dir}/projects`;
    const folders = [...new Set([log.split("/").slice(-2, -1)[0], p?.cwd ? projectSlug(p.cwd) : null].filter(Boolean))];
    await exec("sh", ["-c", 'src=$1; shift; for d in "$@"; do mkdir -p "$d" && cp "$src" "$d/"; done', "sh", log, ...folders.map((f) => `${toDir}/${f}`)], on(m));
  } else {
    const log = s.tool === "codex" ? s.rollout : await claudeLog(s);
    if (!log) { notifyEmpty(); return; }
    handoffFile = `${s.cache}/handoff/${s.sessionId}.md`;
    const r = log ? await helper("agent-transcript-md", [s.tool, log, handoffFile], m).catch(() => null) : null;
    if (r?.code !== 0) { notify({ title: "Couldn't export this conversation", level: "error" }); return; }
  }
  const argv = [...loginShell(platformOf(m)), ...switchArgv({ kind, to, sessionId: s.sessionId, mainArgv: s.argv, handoffFile, machine: m })];
  const space = spaces().find((sp) => sp.tabs.some((t) => t.id === p?.tab));
  const target = accountOf(to.account, m);
  const name = `${(s.name ?? "conversation").slice(0, 18)} → ${target ? (to.tool === "codex" ? accountTitle(target) : target.label) : "Codex"}`;
  const made = parse((await exec("herdr-app", ["do", "tab.new", "--space", space?.id ?? "", "--name", name, "--argv", JSON.stringify(argv)]).catch(() => ({ stdout: "" }))).stdout);
  if (!made?.terminal) { notify({ title: "Switch didn't start", level: "error" }); return; }
  await hc(["label", made.terminal, `herdr.switched.of=${s.terminal}`, `herdr.copy.of.name=${s.name ?? s.terminal}`]).catch(() => null);
  // A new folder asks once whether to trust it; answer that like copies do.
  for (let i = 0; i < 8; i++) {
    await pause(2000);
    const screen = (await hc(["read", made.terminal, "--lines", "15"]).catch(() => null))?.stdout ?? "";
    if (/Yes, I trust this folder/.test(screen)) await hc(["keys", made.terminal, "down", "enter"]).catch(() => null);
    else if (/Trust and continue/.test(screen)) await hc(["keys", made.terminal, "enter"]).catch(() => null);
  }
}
