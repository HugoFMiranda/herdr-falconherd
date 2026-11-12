// Pure helpers shared by the session mods and helpers: no Herdr or Node imports.
// Copied into each mod as core.js (mods can't import each other).

// The tools an account can be for. Claude Code and Codex are known: each runs on a config folder in
// home (its env var points it at another one), conversations are matched to an account by that
// folder, and they fork, switch, resume and show usage. Any other agent or program (Gemini, OpenCode,
// a script) can have accounts too: a command (and a folder, if it has one); its tabs are matched to
// an account by the command they started with, and get its color and icon, nothing more.
export const TOOLS = Object.freeze({
  claude: Object.freeze({ id: "claude", name: "Claude", dir: ".claude", bin: "claude", env: "CLAUDE_CONFIG_DIR", example: "claude-personal", glyph: "my-icons/glyphs/claude.svg", known: true }),
  codex: Object.freeze({ id: "codex", name: "Codex", dir: ".codex", bin: "codex", env: "CODEX_HOME", example: "codex-work", glyph: "my-icons/glyphs/codex-mark.svg", known: true }),
});
const TOOL_ID = /^[a-z0-9][a-z0-9_.-]*$/;
export const toolOf = (account) => (typeof account?.tool === "string" && TOOL_ID.test(account.tool) ? account.tool : "claude");
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// A tool's facts: a known one's, else a program's (named by the account's toolName, else its id).
export const toolInfo = (tool, name = null) => TOOLS[tool] ?? Object.freeze({
  id: tool, name: name || titleCase(tool), dir: null, bin: tool, env: null, example: `${tool}-work`, glyph: "my-icons/glyphs/terminal.svg", known: false,
});
export const accountTool = (a) => toolInfo(toolOf(a), a?.toolName);
// "Claude Work", "Codex", "Gemini Work" (an account named after its tool keeps its name).
export const accountTitle = (a) => {
  const name = accountTool(a).name;
  return a.label === name || a.label.startsWith(`${name} `) ? a.label : `${name} ${a.label}`;
};

// Accounts: { id, tool, toolName? (another program's), label, color, dir (known tools; others may
// have one), icon, bin }. A machine can list its own in machines/<profile>.json ({ "accounts": [...] }),
// named by the Herdr home's gitignored `machine` file; without one, these. Without a Codex account,
// the default one is there (as Codex always was).
const CODEX_ACCOUNT = Object.freeze({ id: "codex", tool: "codex", label: "Codex", color: "#7A9DFF", dir: ".codex", icon: "my-icons/glyphs/codex-mark.svg", bin: "codex" });
export const DEFAULT_ACCOUNTS = Object.freeze([
  Object.freeze({ id: "work", tool: "claude", label: "Work", color: "#3B82F6", dir: ".claude", icon: "my-icons/claude-work.svg", bin: "claude" }),
  Object.freeze({ id: "personal", tool: "claude", label: "Personal", color: "#A855F7", dir: ".claude_personal", icon: "my-icons/claude-personal.svg", bin: "claude-personal" }),
  CODEX_ACCOUNT,
]);

const ACCOUNT_FIELDS = ["id", "label", "color", "icon"];
const validAccount = (a) => ACCOUNT_FIELDS.every((k) => typeof a?.[k] === "string" && a[k])
  && (accountTool(a).known ? typeof a.dir === "string" && a.dir !== "" : a.dir == null || typeof a.dir === "string");
export function accountsFrom(machine) {
  const list = machine?.accounts;
  if (!Array.isArray(list) || list.length === 0) return DEFAULT_ACCOUNTS;
  if (!list.every(validAccount)) return DEFAULT_ACCOUNTS;
  const out = list.map((a) => Object.freeze({ ...a, tool: toolOf(a), dir: a.dir || null, bin: a.bin || accountTool(a).bin }));
  const codex = out.some((a) => a.tool === "codex") || out.some((a) => a.id === CODEX_ACCOUNT.id) ? [] : [CODEX_ACCOUNT];
  return Object.freeze([...out, ...codex]);
}

// Set by Settings' Accounts / + menu / machine colors after they saved this computer's profile: mods read it again.
export const PROFILE_SAVED = "sessions.profile-saved";

// Where Settings opens (an openOverlay spec). Here: this repo's copy of Herdr's Settings with the
// Accounts and + menu sections in it. The shared Falconherd (export-gallery swaps this line) has
// Herdr's own Settings, and the Accounts / + menu sections in a window of their own (falcon-roster).
export const SETTINGS_HOME = Object.freeze({ general: "settings-session", accounts: "settings-session" });
export function settingsOverlay(section, home = SETTINGS_HOME) {
  const ours = section === "accounts" || section === "menu" || section === "titles";
  const mod = ours ? home.accounts : home.general;
  if (mod === "falcon-roster") return { mod, kind: "window", key: "falcon-roster", width: 760, height: 620, props: { section } };
  return { mod, kind: "dialog", width: 880, height: 620, props: { section } };
}

// Each machine's accounts (null: this computer), once a mod has read its profile (session.js);
// the defaults until then.
let byMachine = new Map();
// tool: only that tool's.
export const accounts = (machine = null, tool = null) => {
  const all = byMachine.get(machine ?? null) ?? DEFAULT_ACCOUNTS;
  return tool ? all.filter((a) => toolOf(a) === tool) : all;
};
export const setAccounts = (list, machine = null) => { byMachine = new Map(byMachine).set(machine ?? null, list); };
// A conversation's account ({ tool, account, machine }); a Codex one not matched to a folder is on
// the first Codex account.
export const sessionAccount = (s) => (!s ? null
  : accounts(s.machine).find((a) => a.id === s.account && toolOf(a) === s.tool) ?? (s.tool === "codex" ? accounts(s.machine, "codex")[0] ?? null : null));
// Another program's account for a terminal: the one whose command started it (argv: how the terminal
// was started, maybe through a shell, so any word's last part counts), else, by what Herdr says runs
// there (programKey), its tool's only account. Claude and Codex go by their folder instead (sessionAccount).
const lastPart = (word) => String(word).split(/[\\/]/).pop().replace(/\.exe$/i, "");
export function programAccount({ argv = [], programKey = null, machine = null }) {
  const others = accounts(machine).filter((a) => !accountTool(a).known);
  const words = new Set(argv.map(lastPart));
  const byCommand = others.find((a) => words.has(lastPart(a.bin)));
  if (byCommand) return byCommand;
  const ofTool = programKey ? others.filter((a) => toolOf(a) === programKey) : [];
  return ofTool.length === 1 ? ofTool[0] : null;
}
// The Codex account whose folder a rollout log is under (home: that machine's).
export const codexAccountOf = (rollout, home, machine = null) => accounts(machine, "codex").find((a) => rollout.startsWith(`${home}/${a.dir}/`))?.id ?? null;
// A Codex conversation not matched to a folder (id null) runs on the first Codex account, as it shows.
const binOf = (id, machine, tool = "claude") =>
  (accounts(machine).find((a) => a.id === id) ?? (tool === "codex" ? accounts(machine, "codex")[0] : null))?.bin ?? toolInfo(tool).bin;

// Another machine's color, on everything of it (sidebar, tabs, panes, agents, status bar): one the
// profile of this computer picks ("machines": { "devbox": { "color": "#rrggbb" } }), else one from its
// name, so each machine keeps its own without setup. Apart from the account blue and purple.
export const MACHINE_COLORS = Object.freeze(["#14B8A6", "#F59E0B", "#F43F5E", "#84CC16", "#06B6D4", "#F97316", "#EC4899", "#10B981"]);
let machineLooks = {};
export const setMachineLooks = (looks) => { machineLooks = looks && typeof looks === "object" ? looks : {}; };
// The color picked for a machine in the profile ("" is this computer), or null.
export function pickedColor(machine) {
  const c = machineLooks[machine ?? ""]?.color;
  return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null;
}
export const hereColor = () => pickedColor(null);
export function machineColor(machine) {
  if (!machine) return null;
  const picked = pickedColor(machine);
  if (picked) return picked;
  let h = 2166136261; // FNV-1a
  for (const ch of machine) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return MACHINE_COLORS[h % MACHINE_COLORS.length];
}

// A terminal address is "t3" here, or "devbox/t3" on another machine.
export const machineOf = (address) => (address?.includes("/") ? address.slice(0, address.indexOf("/")) : null);
export const localAddress = (address) => address.slice(address.indexOf("/") + 1);
export const accountByDir = (list, dir) => list.find((a) => a.dir === dir) ?? null;
// Claude's account state (.claude.json): beside the default ~/.claude in home, else inside the dir.
export const stateFile = (account) => (account.dir === ".claude" ? ".claude.json" : `${account.dir}/.claude.json`);

// Windows: the terminal's foreground is its shell, so Claude is found among the shell's descendants.
// procs: [{ pid, ppid, name, cmd }]; nearest first.
export function descendants(procs, pid) {
  const out = [];
  const seen = new Set([pid]);
  let level = [pid];
  while (level.length) {
    const next = procs.filter((p) => level.includes(p.ppid) && !seen.has(p.pid));
    next.forEach((p) => seen.add(p.pid));
    out.push(...next);
    level = next.map((p) => p.pid);
  }
  return out;
}

// A Windows command line as argv (quotes group, as CommandLineToArgvW does for plain cases).
export const splitCommandLine = (line) => [...(line ?? "").matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

export const STALE_MS = 15 * 60 * 1000;

const clamp = (n) => Math.min(100, Math.max(0, n));
const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const isoFromSeconds = (s) => (isNum(s) && s > 0 ? new Date(s * 1000).toISOString() : undefined);
const isoFromString = (s) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

function win(id, label, usedPercent, resetsAt) {
  return { id, label, usedPercent: clamp(usedPercent), ...(resetsAt ? { resetsAt } : {}) };
}

function context(at, used, size, percent) {
  if (!isNum(used) || !isNum(size) || size <= 0) return null;
  return { at, used, size, percent: isNum(percent) ? percent : Math.round((used / size) * 100) };
}

// Claude status line input (rate_limits, context_window).
export function fromStatusline(input, nowMs) {
  const rl = input?.rate_limits;
  const windows = [];
  if (isNum(rl?.five_hour?.used_percentage)) windows.push(win("five_hour", "Session", rl.five_hour.used_percentage, isoFromSeconds(rl.five_hour.resets_at)));
  if (isNum(rl?.seven_day?.used_percentage)) windows.push(win("seven_day", "Weekly", rl.seven_day.used_percentage, isoFromSeconds(rl.seven_day.resets_at)));
  const cw = input?.context_window;
  return {
    limits: windows.length ? { at: nowMs, windows } : null,
    context: cw ? context(nowMs, cw.total_input_tokens, cw.context_window_size, cw.used_percentage) : null,
  };
}

const ratio = (used, limit) => (isNum(used) && isNum(limit) && used >= 0 && limit > 0 ? clamp((used / limit) * 100) : undefined);

function spendPercent(rl) {
  const s = rl.spend;
  if (s?.enabled && s.used?.currency && s.used.currency === s.limit?.currency && s.used.exponent === s.limit?.exponent) {
    const p = ratio(s.used.amount_minor, s.limit.amount_minor);
    if (p !== undefined) return p;
  }
  const e = rl.extra_usage;
  if (e?.is_enabled !== true) return undefined;
  const p = ratio(e.used_credits, e.monthly_limit) ?? e.utilization;
  return isNum(p) && p >= 0 ? clamp(p) : undefined;
}

// Claude Agent SDK get_usage response (as T3 Code reads it: claudeUsageLimits.ts).
export function fromSdkUsage(resp, nowMs) {
  if (!resp?.rate_limits_available || !resp.rate_limits) return null;
  const rl = resp.rate_limits;
  const windows = [];
  if (isNum(rl.five_hour?.utilization)) windows.push(win("five_hour", "Session", rl.five_hour.utilization, isoFromString(rl.five_hour.resets_at)));
  if (isNum(rl.seven_day?.utilization)) windows.push(win("seven_day", "Weekly", rl.seven_day.utilization, isoFromString(rl.seven_day.resets_at)));
  for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    if (typeof m?.display_name !== "string" || !isNum(m.utilization)) continue;
    const slug = m.display_name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    windows.push(win(`seven_day_${slug}`, `Weekly · ${m.display_name}`, m.utilization, isoFromString(m.resets_at)));
  }
  const spend = spendPercent(rl);
  if (spend !== undefined) windows.push(win("monthly_spend", "Monthly spend", spend));
  return { at: nowMs, windows };
}

// Codex rollout `token_count` event.
export function fromCodexTokenCount(event, nowMs) {
  const rl = event?.rate_limits;
  const windows = [];
  if (isNum(rl?.primary?.used_percent)) windows.push(win("five_hour", "Session", rl.primary.used_percent, isoFromSeconds(rl.primary.resets_at)));
  if (isNum(rl?.secondary?.used_percent)) windows.push(win("seven_day", "Weekly", rl.secondary.used_percent, isoFromSeconds(rl.secondary.resets_at)));
  const info = event?.info;
  return {
    limits: windows.length ? { at: nowMs, windows } : null,
    context: info ? context(nowMs, info.last_token_usage?.input_tokens, info.model_context_window) : null,
  };
}

// The newest reading; windows it lacks are kept from the newest reading that has them.
export function newest(readings) {
  const list = readings.filter(Boolean).sort((a, b) => b.at - a.at);
  if (!list.length) return null;
  // Each window keeps its own reading time, so rows carried from an older reading can show their age.
  const windows = list[0].windows.map((w) => ({ ...w, at: list[0].at }));
  for (const r of list.slice(1)) {
    for (const w of r.windows) if (!windows.some((x) => x.id === w.id)) windows.push({ ...w, at: r.at });
  }
  return { at: list[0].at, windows };
}

export const isStale = (at, nowMs) => nowMs - at > STALE_MS;

export function formatTokens(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// Flags that pick a conversation: dropped so the copy resumes this session.
const PICK_FLAGS = new Set(["--continue", "-c"]);
const PICK_WITH_VALUE = new Set(["--resume", "-r", "--session-id"]);

function stripPicks(args, tool) {
  if (tool === "codex") return args; // Codex's -c is --config; its resume / fork subcommands are cut below
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (PICK_FLAGS.has(args[i]) || /^--(continue|resume|session-id)=/.test(args[i])) continue;
    if (PICK_WITH_VALUE.has(args[i])) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

// The command that starts a copy (fork or side chat) of a conversation, with the main's flags.
export function buildCopyArgv({ tool, account, sessionId, mainArgv, machine = null }) {
  // A CLI started through its runtime (node cli.js …): its flags start after the script.
  const runtime = /^(node|bun|deno)(\.exe)?$/i.test(String(mainArgv[0] ?? "").split(/[\\/]/).pop());
  const args = stripPicks(mainArgv.slice(runtime ? 2 : 1), tool);
  if (tool === "codex") {
    // Everything from a resume/fork subcommand on belongs to the session the main came from.
    const sub = args.findIndex((a) => a === "resume" || a === "fork");
    const rest = (sub < 0 ? args : args.slice(0, sub)).filter((a) => a !== "--no-daemon");
    return [binOf(account, machine, "codex"), "--no-daemon", ...rest, "fork", sessionId];
  }
  const skip = args.includes("--dangerously-skip-permissions");
  const bin = binOf(account, machine);
  return [...(skip ? ["env", "IS_SANDBOX=1"] : []), bin, ...args, "--resume", sessionId, "--fork-session"];
}

// Typed into a side chat when Send to main is pressed.
export function briefRequest(mainName, mainTerminal) {
  return `Write a short brief for the main conversation (${mainName}) of what we agreed since your last brief: the decision, the reasons, and the concrete next steps. Then deliver it by running exactly this, with the brief between the markers:\nherdr-brief ${mainTerminal} <<'BRIEF'\nBrief from side chat: <the brief>\nBRIEF\nDo not run hc send ${mainTerminal} yourself; herdr-brief waits while the main conversation is blocked.`;
}

// Agents list sections, in display order.
export const SECTIONS = ["needs", "done", "working", "idle", "snoozed", "settled", "closed"];
export const SECTION_LABELS = { needs: "Needs you", done: "Done", working: "Working", idle: "Idle", snoozed: "Snoozed", settled: "Settled", closed: "Recently closed" };
export const FOLDED_BY_DEFAULT = ["snoozed", "settled", "closed"];

export function sectionOf({ status, settled, snoozedUntil }) {
  if (snoozedUntil) return "snoozed";
  if (settled) return "settled";
  return { blocked: "needs", done: "done", working: "working" }[status] ?? "idle";
}

const SNOOZE_MS = { "30m": 30 * 60000, "1h": 60 * 60000, "3h": 3 * 60 * 60000 };
// "Until I unsnooze": a time that never comes (the latest a Date can hold; JSON keeps it, unlike Infinity).
export const SNOOZE_FOREVER = 8.64e15;
export function snoozeUntil(choice, now) {
  if (choice === "off") return SNOOZE_FOREVER;
  // "Tomorrow morning": in the small hours that's this morning (01:00 → 09:00 today, not in 32 h).
  if (choice === "tomorrow") return new Date(now.getFullYear(), now.getMonth(), now.getDate() + (now.getHours() < 5 ? 0 : 1), 9, 0).getTime();
  return now.getTime() + SNOOZE_MS[choice];
}

export const dueSnoozes = (snoozed, nowMs) => Object.keys(snoozed).filter((t) => snoozed[t] <= nowMs);

// The command that reopens an ended conversation.
export function resumeArgv({ tool, account, sessionId, skipPermissions, machine = null }) {
  if (tool === "codex") return [binOf(account, machine, "codex"), "--no-daemon", "resume", sessionId];
  return [...(skipPermissions ? ["env", "IS_SANDBOX=1"] : []), binOf(account, machine),
    ...(skipPermissions ? ["--dangerously-skip-permissions"] : []), "--resume", sessionId];
}

// After a crash or reboot the core gives each lost terminal a shell in its place (same address,
// never the old command). saved: address -> conversation, as last seen; terms: address -> `hc get`.
const SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "nu", "pwsh", "powershell", "cmd"]);
export const isShell = (name) => SHELLS.has(String(name ?? "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, ""));
// On Windows the foreground stays the shell while an agent runs in it: an agent reporting there
// (status.app) means it isn't lost.
export const lostConversations = (saved, terms) => Object.entries(saved)
  .filter(([address]) => terms[address]?.state === "live" && isShell(terms[address]?.foreground?.name) && !terms[address]?.status?.app)
  .map(([address, conversation]) => ({ address, conversation }));

export const rememberClosed = (list, entry) => [entry, ...list.filter((x) => x.sessionId !== entry.sessionId)].slice(0, 10);

// A model's answer as a tab name: one line, no quotes or end punctuation, the first 3 words, ≤ 24 chars.
// What a plain terminal tab is doing, for its name: the command running in it (fg: `hc get`'s
// foreground), or null while it only shows the shell's prompt.
const SHELL_NAMES = new Set(["bash", "zsh", "fish", "sh", "dash"]);
export function shellTopic(fg, cwd) {
  const argv = fg?.argv ?? [];
  if (!argv.length || SHELL_NAMES.has(fg.name) || argv.some((a) => a.endsWith("/herdr-md-glow"))) return null;
  const cmd = [argv[0].split("/").pop(), ...argv.slice(1)].join(" ").slice(0, 200);
  const home = !cwd || /^\/(home\/[^/]+|root)\/?$/.test(cwd);   // a home folder's name says nothing
  return `the command \`${cmd}\`${home ? "" : ` in the folder ${cwd.split("/").filter(Boolean).pop()}`}`;
}

// A model's answer as a title: its first real line (not a "Here is a title:" lead-in), no quotes, at
// most `words` words, as many of them as fit in `chars` (a long one is shortened, not dropped); file
// paths and end punctuation left out. A refusal or a question back ("I need more context…") is null.
const PATH_WORD = /^([A-Za-z]:[\\/]|[~.]{0,2}\/|\\\\)|[\\/].*[\\/]/;
const NOT_A_TITLE = /^(i\b|i'm|i am|sorry|unable|cannot|can't|could you|please provide|as an ai|there (is|are) no)/i;
export function cleanTitle(raw, words, chars) {
  const lines = String(raw ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const line = (lines.find((l) => !/:$/.test(l)) ?? "").replace(/^["'`“”‘’*_]+|["'`“”‘’*_]+$/g, "");
  if (NOT_A_TITLE.test(line)) return null;
  const kept = [];
  for (const w of line.split(/\s+/).filter((x) => x && !PATH_WORD.test(x)).slice(0, words)) {
    const next = [...kept, w].join(" ").replace(/[.,;:!?]+$/, "");
    if (next.length > chars) break;
    kept.push(w);
  }
  const s = kept.join(" ").replace(/[.,;:!?]+$/, "").trim();
  return s || null;
}
export const cleanTabName = (raw) => cleanTitle(raw, 3, 24);
// The agents list's title for a conversation: up to 6 words, 48 characters.
export const cleanTopic = (raw) => cleanTitle(raw, 6, 48);

// Titles (Settings → Titles, the profile's "titles"). Herdr's behavior by default.
//   tabs: "herdr" (Herdr names them) | "haiku" (Claude Haiku names unnamed tabs from the conversation)
//   cards: the agents list's cards: the tab's name, and under it what's happening or not:
//   "tab" (the name only, as Herdr) | "activity" (while it works, what it says it's doing; between
//   replies, Claude Code's own name for the conversation) | "haiku" (the same, with Claude Haiku's
//   title for what it's doing now between replies, asked again after each reply)
export const TITLE_CHOICES = Object.freeze({ tabs: ["herdr", "haiku"], cards: ["tab", "activity", "haiku"] });
export function titleSettings(profile) {
  const t = { ...(profile?.titles ?? {}) };
  if (t.cards === "claude") t.cards = "activity"; // its earlier name
  const pick = (key) => (TITLE_CHOICES[key].includes(t[key]) ? t[key] : TITLE_CHOICES[key][0]);
  return { tabs: pick("tabs"), cards: pick("cards") };
}
// A tab is named once there are this many prompts, and named again (if still ours) at the second.
export const TAB_NAME_AT = Object.freeze([3, 10]);

// A Claude log's typed prompts, oldest first, from its JSONL lines: not tool results, slash commands,
// their output or reminders. Each at most 400 characters.
export function promptsFrom(lines) {
  const out = [];
  for (const line of lines ?? []) {
    if (!line.includes('"user"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j?.type !== "user" || j.isMeta || j.isSidechain) continue;
    const c = j.message?.content;
    if (Array.isArray(c) && c.some((x) => x?.type === "tool_result")) continue;
    const text = (typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join(" ") : "")
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ").trim();
    if (!text || /^<(command-|local-command|bash-|task-notification)/.test(text) || text.startsWith("Caveat:")) continue;
    out.push(text.replace(/\s+/g, " ").slice(0, 400));
  }
  return out;
}

// Markdown viewer: which files it formats, and where a link inside one goes ("#anchor" dropped).
export const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path ?? "");
export function resolveLink(fromFile, url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return { web: url };
  const raw = url.split("#")[0];
  let clean = raw;
  try { clean = decodeURIComponent(raw); } catch { /* not percent-encoded */ }
  if (!isMarkdown(clean) && !isMarkdown(raw)) return null;
  const from = String(fromFile ?? "").replace(/\\/g, "/");
  const drive = /^[A-Za-z]:/.exec(from)?.[0] ?? "";
  const resolve = (link) => {
    const base = link.startsWith("/") ? "" : from.slice(drive.length, from.lastIndexOf("/") + 1);
    const out = [];
    for (const p of (base + link).split("/")) { if (p === "..") out.pop(); else if (p !== "." && p !== "") out.push(p); }
    return `${drive}/${out.join("/")}`;
  };
  // A link is usually URL-encoded (My%20Doc.md), but a file may really have a % in its name
  // (100%25.md): alt is the path as written, for when the decoded one isn't there.
  const file = resolve(clean);
  return clean === raw ? { file } : { file, alt: resolve(raw) };
}

// Claude Code's own sub-agents (its Agent tool), from <config>/projects/*/<session>/subagents/*.meta.json.
// Running ones first, then newest; finished ones older than SUBAGENT_KEEP_MS drop off.
export const SUBAGENT_KEEP_MS = 30 * 60 * 1000;
// Claude doesn't always mark a sub-agent finished (older or foreground ones have no `finished`),
// and one that crashed stays unfinished: running = not marked finished AND its log moved lately.
export const SUBAGENT_IDLE_MS = 10 * 60 * 1000;
export function subagentsFrom(entries, nowMs, { all = false } = {}) {
  const running = (e) => e.meta.finished !== true && nowMs - e.at <= SUBAGENT_IDLE_MS;
  return entries
    .filter((e) => e.meta && (all || running(e) || nowMs - e.at <= SUBAGENT_KEEP_MS))
    .map((e) => ({ id: e.id, type: e.meta.agentType ?? "agent", description: e.meta.description ?? "", model: e.meta.model ?? null, running: running(e), at: e.at }))
    .sort((x, y) => Number(y.running) - Number(x.running) || y.at - x.at);
}

// Status bar: how close a limit is (green < 50, yellow from 50, red from 80), when it resets, the plan.
export const levelOf = (pct) => (pct >= 80 ? "high" : pct >= 50 ? "warn" : "ok");
export function untilText(resetsAt, nowMs) {
  const t = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(t) || t <= nowMs) return null;
  const m = Math.floor((t - nowMs) / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}
export function planLabel(type) {
  if (!type) return null;
  const s = String(type).replace(/^claude_/, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Switch a conversation to another model, account or tool.
// Claude's per-project log folder: the working directory with every other character as "-".
export const projectSlug = (cwd) => cwd.replace(/[^A-Za-z0-9-]/g, "-");

// The prefix that runs an argv in an interactive bash, so ~/.bashrc's PATH and functions apply.
// On Windows `bash` is WSL's; extras/windows/install.sh gives Git's bash as `gitbash`.
export const loginShell = (platform) => [platform === "windows" ? "gitbash" : "bash", "-ic", 'exec "$@"', "bash"];

// The accounts a conversation can move to; its model stays the conversation's own choice.
// Only Claude and Codex accounts: a conversation can't move to another program.
export const switchTargets = (machine = null) =>
  accounts(machine).filter((a) => accountTool(a).known).map((a) => ({ tool: toolOf(a), account: a.id, label: accountTitle(a) }));

// "same": nothing to do · "account": copy the log to the other Claude account and resume it there ·
// "handoff": the other tool (or another Codex account), given the conversation as a file. A Codex
// conversation not matched to an account (account null) is on the first Codex account.
export function switchKind(from, to) {
  if (from.tool !== to.tool) return "handoff";
  if (from.account === to.account || (from.tool === "codex" && !from.account)) return "same";
  return from.tool === "codex" ? "handoff" : "account";
}

export const handoffPrompt = (file) =>
  `We are continuing a conversation that started with another coding agent. Read ${file}: it is that conversation so far (what was asked, said and done). Then briefly say where things stand and continue from there.`;

export function switchArgv({ kind, to, sessionId, mainArgv, handoffFile, machine = null }) {
  // The chosen model, and the effort the conversation had (Claude only).
  const claudeModel = [...(to.model ? ["--model", to.model] : []), ...(EFFORT_LEVELS.includes(to.effort) ? ["--effort", to.effort] : [])];
  if (kind === "account") return [...buildCopyArgv({ tool: "claude", account: to.account, sessionId, mainArgv, machine }), ...claudeModel];
  // handoff: a fresh session of the other tool, with my usual flags (and the chosen model, if any).
  // Codex's sandbox can't start on this machine (bwrap), so it couldn't even read the handoff file.
  if (to.tool === "codex") return [binOf(to.account, machine, "codex"), "--no-daemon", "--dangerously-bypass-approvals-and-sandbox", ...(to.model ? ["-m", to.model] : []), handoffPrompt(handoffFile)];
  return ["env", "IS_SANDBOX=1", binOf(to.account, machine), "--dangerously-skip-permissions", ...claudeModel, handoffPrompt(handoffFile)];
}

// Typing a command into Claude: `hc keys` presses keys at once (`hc send` waits ~5 s first).
const NL = String.fromCharCode(10);

// Claude's "Set model to <label>" among the last lines with text on screen: the switch is done (an older one
// further up doesn't count).
export function modelSetRecently(screen, label) {
  // Claude draws from the top and keeps its input line at the bottom, blank rows between: count only
  // lines with something on them.
  const recent = (screen ?? "").split(NL).filter((l) => l.trim()).slice(-15).join(NL);
  return recent.includes(`Set model to ${label}`) || recent.includes("Set model to `" + label + "`");
}

// keysFor(text): hc key names for it, or null if it has a character hc keys doesn't know.
export const keysFor = (text) => (/^[A-Za-z0-9/. -]+$/.test(text ?? "") ? [...text].map((c) => (c === " " ? "space" : c)) : null);

// Claude's effort levels, as /effort takes them (the status bar's menu offers them).
export const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

// Models offered in the status bar's model menu (Claude: /model <id>; Codex: its own /model picker).
// Claude's are only the fallback: claude-usage saves each account's own list (modelsFrom), which the
// menus prefer. value is what /model and --model take (a short name; the full id isn't accepted).
export const MODEL_CHOICES = {
  claude: [["claude-fable-5-2", "fable", "Fable 5.2"], ["claude-opus-5-5", "opus", "Opus 5.5"], ["claude-sonnet-5-5", "sonnet", "Sonnet 5.5"], ["claude-haiku-5-5", "haiku", "Haiku 5.5"]]
    .map(([id, value, label]) => ({ id, value, label, efforts: [...EFFORT_LEVELS] })),
  codex: [["gpt-6.1-sol", "GPT-6.1 Sol"], ["gpt-6.1-terra", "GPT-6.1 Terra"], ["gpt-6-luna", "GPT-6 Luna"], ["gpt-6-astra", "GPT-6 Astra"]]
    .map(([id, label]) => ({ id, label })),
};

export const modelValue = (m) => m.value ?? m.id;
// The list of a switch target ({ tool, account }) in the menus' model lists.
export const modelKey = (to) => `${to.tool}:${to.account ?? ""}`;

// The Agent SDK's models for an account (initialization's `models`) as menu entries, without its
// "default" alias: { id, value, label, efforts }. null when there are none.
export function modelsFrom(sdk) {
  if (!Array.isArray(sdk)) return null;
  const list = sdk.filter((m) => typeof m?.value === "string" && m.value !== "default" && typeof m.resolvedModel === "string")
    .map((m) => ({
      id: m.resolvedModel, value: m.value, label: typeof m.displayName === "string" ? m.displayName : m.value,
      efforts: m.supportsEffort === false ? [] : EFFORT_LEVELS.filter((l) => (m.supportedEffortLevels ?? EFFORT_LEVELS).includes(l)),
    }));
  return list.length ? list : null;
}

// The menus' models: ones with a short name (and lists without any, like Codex's), and the older
// versions an account also offers, by full id, behind "Other models".
export const splitModels = (list) => ({
  main: list.filter((m) => !m.value || m.value !== m.id),
  more: list.filter((m) => m.value && m.value === m.id),
});

// A model's own weekly limit ("Weekly · Fable" for claude-fable-*), when the account has one.
export function modelLimit(limits, modelId) {
  const family = /^claude-([a-z]+)-/.exec(modelId ?? "")?.[1];
  return (family && limits?.windows?.find((w) => w.id === `seven_day_${family}`)) || null;
}

// Settled tabs to close (their conversations go to Recently closed, to resume from there): settled
// for maxMs or more, not snoozed, every pane an agent and none working, and never a space's last tab.
export function staleSettled(spaces, panes, snoozed, nowMs, maxMs) {
  const stale = (tab) => {
    if (!tab.settled || !tab.settled_at || nowMs - tab.settled_at < maxMs) return false;
    const mine = panes.filter((p) => p.tab === tab.id);
    return mine.length > 0 && mine.every((p) => p.program?.agent && p.status !== "working" && !snoozed[p.terminal]);
  };
  return spaces.flatMap((sp) => {
    const ids = sp.tabs.filter(stale).map((tab) => tab.id);
    return ids.length === sp.tabs.length ? ids.slice(1) : ids; // keep one: closing the last tab closes the space
  });
}

// Whether a mod's block is on screen in a layout() tree: no hidden node above it, and at each stack
// it's the active page. A mod not in the layout (a pane, a window, a popup) counts as shown.
// Panels poll gently while hidden: Herdr keeps them alive behind a hidden column or stack page.
export function modShown(tree, mod) {
  let found = false;
  const walk = (n, visible) => {
    if (!n || typeof n !== "object") return false;
    const here = visible && !n.hidden;
    if (n.content?.mod === mod) { found = true; if (here) return true; }
    return (n.children ?? []).some((c) => walk(c, here && (n.type !== "stack" || n.active == null || n.active === c.id)));
  };
  return walk(tree?.root ?? tree, true) || !found;
}

// The Accounts and + menu sections: colors offered for an account, what's wrong with an
// account drafted there (none: it can be saved), and a new account's id.
export const ACCOUNT_COLORS = Object.freeze(["#3B82F6", "#A855F7", "#14B8A6", "#F59E0B", "#F43F5E", "#84CC16", "#06B6D4", "#EC4899"]);
const HOME_DIR = /^\.[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
export function accountProblems(draft, others) {
  const out = [];
  const label = (draft.label ?? "").trim();
  if (!label) out.push("Give it a name");
  const named = TOOL_ID.test(draft.tool ?? "claude");
  if (!named) out.push("Name the program it's for");
  const tool = named ? accountTool(draft) : toolInfo("program");
  // A known tool's folder is how its conversations are matched; another program's is optional.
  const dir = (draft.dir ?? "").trim();
  if (tool.known || dir) {
    if (!HOME_DIR.test(dir) || dir.includes("..")) out.push(`The config folder is a folder in home starting with a dot, like ${tool.dir ?? `.${tool.id}`}_work`);
  }
  const bin = (draft.bin ?? "").trim();
  if (!bin) out.push(`Give the command that starts ${tool.name} on it`);
  else if (tool.known && bin === tool.bin && HOME_DIR.test(dir) && dir !== tool.dir) {
    out.push(`${tool.bin} uses ~/${tool.dir}: for ${dir}, give a command that sets ${tool.env} (like ${tool.example})`);
  }
  // Another program's tabs are matched by their command: two accounts on one command can't be told apart.
  if (!tool.known && bin && others.some((a) => !accountTool(a).known && (a.bin ?? "").trim() === bin)) out.push(`Another account starts with ${bin}`);
  if (!/^#[0-9a-fA-F]{6}$/.test(draft.color ?? "")) out.push("The color is #rrggbb");
  if (dir && others.some((a) => a.dir === dir)) out.push(`Another account uses ${dir}`);
  if (label && others.some((a) => a.label.trim().toLowerCase() === label.toLowerCase())) out.push(`Another account is called ${label}`);
  return out;
}
export function accountId(label, taken) {
  const base = (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

// Account icons: one-color glyphs, drawn in the account's color. tool: the one they picture (null: any).
// tool: the one a mark pictures (offered on that tool's accounts only); null: a shape for any account.
export const ACCOUNT_GLYPHS = Object.freeze([
  ["briefcase", "Work"], ["home", "Home"], ["star", "Star"], ["bolt", "Bolt"], ["heart", "Heart"], ["flask", "Lab"],
  ["code", "Code"], ["circle", "Circle"], ["hexagon", "Hexagon"], ["cloud", "Cloud"], ["spark", "Spark"], ["terminal", "Terminal"],
  ["claude", "Claude"], ["claude-work", "Claude, work"], ["claude-home", "Claude, home"], ["claude-star", "Claude, star"],
  ["codex-mark", "Codex"], ["codex-mark-work", "Codex, work"], ["codex-mark-home", "Codex, home"], ["codex-mark-star", "Codex, star"],
].map(([name, label]) => Object.freeze({ path: `my-icons/glyphs/${name}.svg`, label, tool: name.split("-")[0] in TOOLS ? name.split("-")[0] : null })));
// An account's choices: its tool's own marks first (own: more, like Herdr's icon for another program),
// then the shapes, then the other tools' marks (any account can wear one).
export const glyphsFor = (tool, own = []) => [...own, ...ACCOUNT_GLYPHS.filter((g) => g.tool === tool),
  ...ACCOUNT_GLYPHS.filter((g) => !g.tool), ...ACCOUNT_GLYPHS.filter((g) => g.tool && g.tool !== tool)];

// Accounts' config folders found in home that no account uses yet: { tool, dir, label, bin }.
// names: a listing's paths, folders ending in "/". Claude's are .claude or .claude_<name> /
// .claude-<name>, Codex's alike. The command is the tool's for its default folder, else a guess at
// its wrapper (claude-<name>, as claude-personal), to check in the form.
const FOUND_DIR = /^\.(claude|codex)(?:[-_]([A-Za-z0-9][A-Za-z0-9_.-]*))?$/;
export function foundAccounts(names, list) {
  const used = new Set(list.map((a) => a.dir).filter(Boolean));
  const out = [];
  for (const raw of names) {
    const line = String(raw).trim();
    if (!line.endsWith("/")) continue; // folders only (.claude.json is a file)
    const dir = line.slice(0, -1).split("/").pop();
    const m = FOUND_DIR.exec(dir);
    if (!m || used.has(dir)) continue;
    const [, tool, suffix] = m;
    const label = suffix ? suffix.split(/[-_.]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : TOOLS[tool].name;
    const bin = suffix ? `${TOOLS[tool].bin}-${suffix.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : TOOLS[tool].bin;
    out.push({ tool, dir, label, bin });
  }
  return out;
}

// The + menu's order: menu.order, the keys (its entries' ids, Herdr's agents' keys) in the order
// shown. Ones it doesn't name come after, in their own order.
export const menuOrder = (profile) => (Array.isArray(profile?.menu?.order) ? profile.menu.order.filter((k) => typeof k === "string") : []);
export function inMenuOrder(items, order) {
  const at = new Map(order.map((k, i) => [k, i]));
  return items.map((item, i) => ({ item, rank: at.get(item.key) ?? order.length + i })).sort((a, b) => a.rank - b.rank).map((x) => x.item);
}
// keys with the one at `from` moved to `to`.
export function moveKey(keys, from, to) {
  if (from === to || from < 0 || to < 0 || from >= keys.length || to >= keys.length) return [...keys];
  const out = keys.filter((_, i) => i !== from);
  out.splice(to, 0, keys[from]);
  return out;
}

// A command line as argv: words, "..." or '...' keep spaces. null when a quote isn't closed.
export function splitCommand(text) {
  const out = [];
  let word = null, quote = null;
  for (const c of String(text ?? "")) {
    if (quote) { if (c === quote) quote = null; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; word = word ?? ""; continue; }
    if (/\s/.test(c)) { if (word !== null) out.push(word); word = null; continue; }
    word = (word ?? "") + c;
  }
  if (quote) return null;
  if (word !== null) out.push(word);
  return out;
}
// Both quote kinds in one word: '…' pieces with each ' as "'" between them (splitCommand joins them).
const quoteWord = (a) => (a !== "" && !/[\s"']/.test(a) ? a
  : a.includes('"') && a.includes("'") ? a.split("'").map((p) => `'${p}'`).join(`"'"`)
  : a.includes('"') ? `'${a}'` : `"${a}"`);
export const joinCommand = (argv) => (argv ?? []).map(quoteWord).join(" ");

// programs.json's programs: the base's, changed field by field by a profile's "programs" (null: leave it out).
function mergePrograms(base, changes) {
  const out = { ...(base ?? {}) };
  for (const [key, entry] of Object.entries(changes ?? {})) {
    if (entry === null) delete out[key];
    else out[key] = { ...(out[key] ?? {}), ...entry };
  }
  return out;
}
const runOf = (p) => (Array.isArray(p?.run) && p.run.length > 0 && p.run.every((a) => typeof a === "string") ? [...p.run] : null);

// A launcher's id: its programs.json key.
const LAUNCHER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// The + menu's own entries: { id, name, run, account (a Claude account's id: its icon, in its color) or icon }.
// A profile's "launchers"; without them, the entries with `run` programs.json has now (the base and
// the profile's changes), each on the account whose icon it shows.
export function launchersFrom(profile, base) {
  const accts = accountsFrom(profile);
  const known = (id) => (accts.some((a) => a.id === id) ? id : null);
  if (Array.isArray(profile?.launchers)) {
    return profile.launchers
      .filter((l) => typeof l?.id === "string" && LAUNCHER_ID.test(l.id) && typeof l.name === "string" && l.name.trim() && runOf(l))
      .map((l) => ({ id: l.id, name: l.name, run: runOf(l), account: known(l.account), icon: typeof l.icon === "string" ? l.icon : null, tint: Boolean(l.tint) }));
  }
  return Object.entries(mergePrograms(base?.programs, profile?.programs)).filter(([id, p]) => LAUNCHER_ID.test(id) && runOf(p)).map(([id, p]) => {
    const account = accts.find((a) => a.icon === p.icon)?.id ?? null;
    return { id, name: p.name ?? id, run: runOf(p), account, icon: account ? null : p.icon ?? null, tint: Boolean(p.tint) };
  });
}

// programs.json: the base with the profile's changes; with launchers, they are the + menu's entries
// (the base's own entries with `run` go).
export function programsFrom(base, profile) {
  const merged = mergePrograms(base?.programs, profile?.programs);
  if (!Array.isArray(profile?.launchers)) return { ...base, programs: merged };
  const accts = accountsFrom(profile);
  const kept = Object.fromEntries(Object.entries(merged).filter(([, p]) => !runOf(p)));
  const ours = launchersFrom(profile, base).map((l) => {
    const a = l.account ? accts.find((x) => x.id === l.account) : null;
    const icon = a ? a.icon : l.icon;
    return [l.id, { name: l.name, ...(icon ? { icon } : {}), tint: a ? true : l.tint, run: l.run }];
  });
  return { ...base, programs: { ...kept, ...Object.fromEntries(ours) } };
}

// The + menu entries' icon and color, for the ones on a Claude account.
export function launcherLooks(profile, base) {
  const accts = accountsFrom(profile);
  return Object.fromEntries(launchersFrom(profile, base).flatMap((l) => {
    const a = l.account ? accts.find((x) => x.id === l.account) : null;
    return a ? [[l.id, { icon: a.icon, color: a.color }]] : [];
  }));
}

// The agents (programs.json keys) the + menu leaves out.
export const menuHidden = (profile) => (Array.isArray(profile?.menu?.hidden) ? profile.menu.hidden.filter((k) => typeof k === "string") : []);

// What's wrong with a + menu entry drafted in the settings page: { name, command, account, icon }.
export function launcherProblems(draft, others) {
  const out = [];
  const name = (draft.name ?? "").trim();
  if (!name) out.push("Give it a name");
  const argv = splitCommand(draft.command);
  if (argv === null) out.push("Close the quote in the command");
  else if (argv.length === 0) out.push("Give the command it runs");
  if (!draft.account && !draft.icon) out.push("Pick an account or an icon");
  if (name && others.some((l) => l.name.trim().toLowerCase() === name.toLowerCase())) out.push(`Another entry is called ${name}`);
  return out;
}

// The launcher's search (falcon-launch): items whose name or command matches every word of the
// query, best first: the name starting with it, then a word of the name, then anywhere in the name,
// then the command. No query: all of them, as they are.
export function launchMatches(items, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [...items];
  const words = q.split(/\s+/);
  const rank = (item) => {
    const name = String(item.name ?? "").toLowerCase();
    const command = (item.run ?? []).join(" ").toLowerCase();
    if (!words.every((w) => name.includes(w) || command.includes(w))) return null;
    if (name.startsWith(q)) return 0;
    if (name.split(/[^a-z0-9]+/).some((part) => part.startsWith(words[0]))) return 1;
    if (name.includes(words[0])) return 2;
    return 3;
  };
  return items.map((item, i) => ({ item, i, r: rank(item) })).filter((x) => x.r !== null)
    .sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.item);
}

// A key binding ("ctrl-shift-t", chords split by spaces) as people read it: "Ctrl+Shift+T", or on
// macOS "⇧⌘T". "secondary" is Cmd on macOS and Ctrl elsewhere.
export function keyLabel(binding, platform) {
  const mac = platform === "macos";
  const order = ["ctrl", "alt", "shift", "cmd"];
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Win" };
  const alias = { secondary: mac ? "cmd" : "ctrl", control: "ctrl", option: "alt", super: "cmd", win: "cmd", meta: "cmd", platform: "cmd" };
  const stroke = (s) => {
    const dash = s.endsWith("--");
    const parts = (dash ? s.slice(0, -2) : s).split("-").filter(Boolean);
    const key = dash ? "-" : parts.pop() ?? "";
    const held = new Set(parts.map((p) => alias[p.toLowerCase()] ?? p.toLowerCase()));
    const label = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
    const mods = order.filter((m) => held.has(m)).map((m) => names[m]);
    return mac ? [...mods.sort((a, b) => "⌃⌥⇧⌘".indexOf(a) - "⌃⌥⇧⌘".indexOf(b)), label].join("") : [...mods, label].join("+");
  };
  return String(binding ?? "").trim().split(/\s+/).filter(Boolean).map(stroke).join(" ");
}

// The tab bar (falcon-perch). A tab's title: its name, or (never named: "tb3") its program's.
export const tabTitle = (tab, program) => `${/^tb\d+$/.test(tab?.name ?? "") ? program?.name ?? "Terminal" : tab.name}${tab?.zoomed ? " · zoomed" : ""}`;
// "5m", "3h", "2d" ago (at least 1m).
export const shortAgo = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : ms < 86400000 ? `${Math.round(ms / 3600000)}h` : `${Math.round(ms / 86400000)}d`);
// The side panel a space shows when it's switched to: its last choice (null: closed), if the layout
// still has that panel; undefined when it never chose (leave the panel as it is).
export function panelFor(memory, space, panels) {
  if (!(space in (memory ?? {}))) return undefined;
  const want = memory[space];
  return want && panels.includes(want) ? want : null;
}

// The pane header (falcon-hood). A folder with home as "~".
export function homeLabel(cwd, home) {
  if (!cwd) return "";
  const c = String(cwd).replace(/\\/g, "/"), h = String(home ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!h) return c;
  return c === h ? "~" : c.startsWith(`${h}/`) ? `~${c.slice(h.length)}` : c;
}
// Where a conversation came from, by the labels a fork, side chat or move gave its terminal.
export function originOf(labels) {
  const l = labels ?? {};
  const name = (of) => l["herdr.copy.of.name"] ?? of;
  if (l["herdr.sidechat.of"]) return `side chat of ${name(l["herdr.sidechat.of"])}`;
  if (l["herdr.fork.of"]) return `fork of ${name(l["herdr.fork.of"])}`;
  if (l["herdr.switched.of"]) return `moved from ${name(l["herdr.switched.of"])}`;
  return null;
}

// The agents list's filter chips (falcon-flock): one per account and per machine among the agents,
// only for a kind with more than one value. items: { account: { id, label, color } | null, machine }.
export function flockFacets(items) {
  const accounts = new Map(), machines = new Map();
  for (const it of items) {
    if (it.account) accounts.set(it.account.id, { key: `account:${it.account.id}`, label: it.account.label, color: it.account.color, count: (accounts.get(it.account.id)?.count ?? 0) + 1 });
    const m = it.machine ?? "";
    machines.set(m, { key: `machine:${m}`, label: m || "This computer", machine: it.machine ?? null, count: (machines.get(m)?.count ?? 0) + 1 });
  }
  return [...(accounts.size > 1 ? accounts.values() : []), ...(machines.size > 1 ? machines.values() : [])];
}
// An item passes the chosen chips: for each kind chosen, it matches one of that kind's chips.
export function flockMatches(item, chosen) {
  const kinds = { account: [], machine: [] };
  for (const key of chosen) { const [kind, value] = key.split(/:(.*)/s); kinds[kind]?.push(value); }
  if (kinds.account.length && !kinds.account.includes(item.account?.id ?? "\u0000")) return false;
  if (kinds.machine.length && !kinds.machine.includes(item.machine ?? "")) return false;
  return true;
}

// Copying a file or folder between machines (falcon-files): a tar stream through herdr-core, run by a
// shell here (Git's bash on Windows). from: { machine (null: here), dir, name }; to: { machine, dir }.
// Here, tar on Windows gets --force-local (else "C:" is a host), and Git's bash leaves paths alone.
export const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
// The packing side says so on stderr when it fails (not every sh has pipefail).
export const PACK_FAILED = "falconherd: reading the source failed";
// How a copy went, from its exit code and stderr: GNU tar exits 1 when a file changed while it was
// read, after writing a complete archive. That alone is a copy that worked, with a note.
export function transferOutcome(code, stderr) {
  const lines = String(stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (code !== 0) return { ok: false };
  if (!lines.includes(PACK_FAILED)) return { ok: true };
  const rest = lines.filter((l) => l !== PACK_FAILED);
  return rest.length && rest.every((l) => /file changed as we read it/i.test(l))
    ? { ok: true, note: "A file changed while it was copied: the copy has it as it was then." }
    : { ok: false };
}
// A destination as typed: "~" or "~/x" is that machine's home (another machine: relative to its
// home, where its commands start).
export function expandDest(dir, machine, home) {
  const d = String(dir ?? "").trim();
  if (d !== "~" && !d.startsWith("~/")) return d;
  if (machine) return d.slice(2) || ".";
  return `${String(home ?? "").replace(/\\/g, "/").replace(/\/+$/, "")}${d.slice(1)}`;
}
export function transferCommand({ from, to, windows = false }) {
  if ((from.machine ?? null) === (to.machine ?? null)) throw new Error("the same machine: nothing to copy");
  if (!from.name || /[\\/]/.test(from.name) || from.name === "." || from.name === "..") throw new Error("not a file or folder name");
  const q = shellQuote, raw = "MSYS_NO_PATHCONV=1";
  const tar = `tar${windows ? " --force-local" : ""}`;
  const packing = from.machine
    ? `${raw} hc exec --on ${q(from.machine)} -- tar -C ${q(from.dir)} -cf - ${q(from.name)}`
    : `${raw} ${tar} -C ${q(from.dir)} -cf - ${q(from.name)}`;
  const pack = `{ ${packing} || echo ${q(PACK_FAILED)} >&2; }`;
  if (to.machine) return `${pack} | ${raw} hc exec -i --on ${q(to.machine)} -- sh -c 'mkdir -p "$1" && tar -xmf - -C "$1"' sh ${q(to.dir)}`;
  return `mkdir -p ${q(to.dir)} && ${pack} | ${raw} ${tar} -xmf - -C ${q(to.dir)}`;
}
// Where it goes unless changed: the same project's folder on that machine (a space there whose folder
// has the same name), else that machine's Downloads (in home: a relative path on another machine).
export function transferDefault({ to, fromFolder, spaces, home }) {
  const base = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const project = (fromFolder ?? "").split(/[\\/]/).filter(Boolean);
  const there = (spaces ?? []).filter((s) => (s.machine ?? null) === (to ?? null) && s.folder);
  const match = there.find((s) => project.includes(base(s.folder)));
  if (match) return match.folder;
  return to ? "Downloads" : `${home}/Downloads`;
}

// The changes panel (falcon-changes). Files from `git status --porcelain=v1` entries and the line
// counts per side (staged: index vs HEAD; changes: work tree vs index): one row per side a file has
// changes on. status: M, A (new or untracked), D, U (conflict).
export function changedFiles(entries, staged, changed) {
  const out = [];
  for (const entry of entries) {
    const x = entry[0], y = entry[1], path = entry.slice(3), fresh = x === "?";
    const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    const letter = (c) => (conflict ? "U" : c === "D" ? "D" : c === "A" || c === "?" ? "A" : "M");
    if (!fresh && x !== " ") out.push({ path, side: "staged", status: letter(x), add: 0, del: 0, ...(staged[path] ?? {}) });
    if (fresh || y !== " ") out.push({ path, side: "changes", status: letter(fresh ? "?" : y), fresh, add: 0, del: 0, ...(changed[path] ?? {}) });
  }
  return out;
}
// A diff's lines numbered: hunk headers, then each line with its number on its side.
export function numberDiff(lines) {
  let old = 0, now = 0;
  return lines.map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = Number(m[1]); now = Number(m[2]); return { kind: "@", text: line }; }
    const kind = line[0], text = line.slice(1) || " ";
    if (kind === "-") return { kind, number: old++, text };
    if (kind === "+") return { kind, number: now++, text };
    if (kind === " ") { old++; return { kind, number: now++, text }; }
    return { kind: "", text: line };
  });
}

// The sidebar (falcon-roost). A smart folder's rules ("Collect spaces from"): comma-separated; a
// rule starting with "/" is a path from the root, with "~" a path from any home (/home/x, /Users/x,
// /root, C:/Users/x), else a folder name (or names/like/this) at any depth; "*" is any part of one
// name. A rule takes that folder and everything in it. How far into the path the best rule reaches
// (0: none): the deeper the rule, the more it reaches.
const toSlash = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
export function ruleReach(rules, path) {
  const p = toSlash(path);
  if (!p) return 0;
  return Math.max(0, ...String(rules ?? "").split(",").map((raw) => {
    const r = toSlash(raw.trim());
    if (!r) return 0;
    const body = r.replace(/^~/, "\u0000").split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
      .replace("\u0000", "(?:/home/[^/]+|/Users/[^/]+|/root|[A-Za-z]:/Users/[^/]+)");
    const m = new RegExp(`${/^[/~]/.test(r) ? "^" : "(?:^|/)"}${body}(?:/|$)`, "i").exec(p);
    return m ? 1 + m.index + m[0].replace(/\/$/, "").length : 0;
  }));
}
// A space's folder: where it was put (of[id]: a folder id, "" for none), else the smart folder whose
// rules reach deepest into where it works (the first on a tie), else none.
export function folderFor(space, folders, of) {
  if (space.id in (of ?? {})) return folders.some((f) => f.id === of[space.id]) ? of[space.id] : null;
  let best = null, most = 0;
  for (const f of folders) { const n = ruleReach(f.rules, space.place); if (n > most) { best = f.id; most = n; } }
  return best;
}
// Space colors: ten, the theme's six first.
export const SPACE_PALETTE = Object.freeze(["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1", "#e5b94a", "#4fb3d9", "#e0605a", "#9aa53a"]);
// colors: space -> color. Spaces open now keep theirs, or get the least used one; colors of spaces
// gone go, except those kept (a disconnected machine's spaces, back later). null: nothing changed.
export function assignColors(colors, open, keep) {
  const alive = new Set([...open, ...keep]);
  const next = Object.fromEntries(Object.entries(colors ?? {}).filter(([id]) => alive.has(id)));
  for (const id of open) {
    if (next[id]) continue;
    const used = (c) => Object.values(next).filter((x) => x === c).length;
    next[id] = SPACE_PALETTE.reduce((best, c) => (used(c) < used(best) ? c : best), SPACE_PALETTE[0]);
  }
  const same = Object.keys(next).length === Object.keys(colors ?? {}).length && Object.entries(next).every(([k, v]) => colors[k] === v);
  return same ? null : next;
}
// A space row's repo line: the repo (unless it's the space's name, or a worktree row), the branch
// (unless main, master or the space's name), ↑ahead ↓behind.
export function gitTail(g, spaceName, worktree) {
  if (!g) return "";
  const same = (x) => String(x ?? "").toLowerCase() === String(spaceName ?? "").toLowerCase();
  const branch = !g.branch || g.branch === "(detached)" ? "detached" : g.branch;
  const parts = [!worktree && g.name && !same(g.name) ? g.name : null, worktree || !(["main", "master"].includes(branch) || same(branch)) ? branch : null].filter(Boolean);
  return [parts.join(" · "), g.ahead > 0 ? `↑${g.ahead}` : "", g.behind > 0 ? `↓${g.behind}` : ""].filter(Boolean).join(" ");
}
// Rows in order, each worktree (linked) moved right under the first main checkout of its repo
// (marked worktree); a worktree whose checkout isn't listed stays where it is.
export function nestWorktrees(rows) {
  const mains = new Set(rows.filter((r) => r.repo && !r.linked).map((r) => r.repo));
  const under = (r) => r.repo && r.linked && mains.has(r.repo);
  const out = [], placed = new Set();
  for (const r of rows) {
    if (under(r)) continue;
    out.push(r);
    if (r.repo && !r.linked && !placed.has(r.repo)) {
      placed.add(r.repo);
      out.push(...rows.filter((w) => w.repo === r.repo && under(w)).map((w) => ({ ...w, worktree: true })));
    }
  }
  return out;
}
