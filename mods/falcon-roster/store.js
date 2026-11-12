// Loading and saving this repo's Settings sections: this computer's profile (machines/<profile>.json,
// named by the gitignored `machine` file, made on the first change when there's none, its other keys
// kept) and programs.json from it (the same as the herdr-programs script), then PROFILE_SAVED so every mod
// reads it again. A change saves at once, like Herdr's own settings.
import { v_flex } from "gpui-base";
import { props, appHome, readTextFile, writeTextFile, setShared, hc, knownAgents, exec, window } from "herdr";
import { accountsFrom, launchersFrom, programsFrom, menuHidden, menuOrder, foundAccounts, DEFAULT_ACCOUNTS, PROFILE_SAVED } from "./core.js";
import { note } from "./ui.js";

const NEW_PROFILE = "local";
const parse = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
const read = (path) => readTextFile(path).catch(() => null);
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// The sections' state, on Herdr's Settings view; loaded in the background.
export function mySectionsInit(view, cx) {
  const m = {
    loaded: false, editing: null, colorOpen: props()?.machine ?? null, agents: [], allAgents: false, drag: null,
    // Until (or unless) load fills them in.
    where: "machines/", data: {}, list: [], launchers: [], hidden: [], order: [], looks: {}, machineNames: [], baseRun: [],
    finding: false, found: null, // the last search for accounts' folders (findAccounts)
  };
  view.mine = m;
  cx.spawn(async (cx) => {
    try { await load(m); } catch (err) { m.error = `Couldn't read this computer's settings: ${String(err).slice(0, 160)}`; }
    m.loaded = true;
    cx.notify();
  });
  cx.spawn(async (cx) => {
    try { m.agents = await knownAgents(); m.agentsLoaded = true; } catch { m.agentsFailed = true; }
    cx.notify();
  });
}

export async function load(m) {
  const home = appHome();
  const named = (await read(`${home}/machine`))?.trim() || null;
  m.profile = named && /^[A-Za-z0-9_-]+$/.test(named) ? named : null;
  m.where = `machines/${m.profile ?? NEW_PROFILE}.json`;
  m.file = `${home}/${m.where}`;
  // Read even without a profile: a machines/local.json left by a first save that stopped before
  // writing the `machine` file is then written over, not refused as stale.
  m.text = await read(m.file);
  const data = parse(m.text);
  // programs.json is made from programs.base.json plus the profile. A home without the base (a fresh
  // install of the shared layout) gets one from its programs.json as it is, so nothing in it is lost.
  let baseText = await read(`${home}/programs.base.json`);
  if (baseText == null) {
    const current = await read(`${home}/programs.json`);
    baseText = isObject(parse(current)) ? current : `${JSON.stringify({ programs: {} }, null, 2)}\n`;
    await writeTextFile(`${home}/programs.base.json`, baseText, null).catch(async () => { baseText = await read(`${home}/programs.base.json`); });
  }
  const base = parse(baseText);
  // Saving over what couldn't be read would lose it: say why instead, and don't save.
  if (m.text?.trim() && !isObject(data)) m.error = `${m.where} isn't valid JSON. Fix it (or remove it), then open Settings again.`;
  else if (!isObject(base)) m.error = "programs.base.json is missing or isn't valid JSON. Fix it, then open Settings again.";
  else if (Array.isArray(data?.accounts) && data.accounts.length && accountsFrom(data) === DEFAULT_ACCOUNTS) {
    m.error = `An account in ${m.where} lacks one of id, label, color, dir, icon. Fix it, then open Settings again.`;
  }
  m.data = isObject(data) ? data : {};
  m.base = isObject(base) ? base : { programs: {} };
  m.baseRun = Object.entries(m.base.programs ?? {}).filter(([, p]) => Array.isArray(p?.run)).map(([k]) => k);
  m.list = accountsFrom(m.data).map((a) => ({ ...a }));
  m.launchers = launchersFrom(m.data, m.base);
  m.hidden = menuHidden(m.data);
  m.order = menuOrder(m.data);
  m.looks = { ...(m.data.machines ?? {}) };
  const r = await hc(["machine", "ls", "--json"]).catch(() => null);
  const known = parse(r?.stdout)?.machines?.filter((x) => !x.temporary).map((x) => x.name) ?? [];
  m.machineNames = [...new Set([...known, ...Object.keys(m.looks)])].sort();
}

// The profile as it's saved: these sections' parts; its other keys kept. The old per-entry changes
// to the + menu's programs ("programs" on the base's entries with run) are in the launchers now.
function nextProfile(m) {
  const machines = Object.fromEntries(Object.entries(m.looks).filter(([, v]) => v?.color));
  const programs = Object.fromEntries(Object.entries(m.data.programs ?? {}).filter(([k]) => !m.baseRun.includes(k)));
  const { programs: _old, machines: _was, ...rest } = m.data;
  return {
    ...rest,
    accounts: m.list.map(({ id, tool, toolName, label, color, dir, icon, bin }) => ({ id, tool, ...(toolName ? { toolName } : {}), label, color, ...(dir ? { dir } : {}), icon, bin })),
    launchers: m.launchers.map(({ id, name, run, account, icon, tint }) => (account ? { id, name, run, account } : { id, name, run, icon, tint })),
    menu: { ...(m.data.menu ?? {}), hidden: m.hidden, order: m.order },
    ...(Object.keys(machines).length ? { machines } : {}),
    ...(Object.keys(programs).length ? { programs } : {}),
  };
}

async function persist(m) {
  const home = appHome();
  const next = nextProfile(m);
  const text = JSON.stringify(next, null, 2) + "\n";
  await writeTextFile(m.file, text, m.text);
  m.text = text;
  m.data = next;
  if (!m.profile) {
    await writeTextFile(`${home}/machine`, `${NEW_PROFILE}\n`, await read(`${home}/machine`));
    m.profile = NEW_PROFILE;
  }
  // programs.json is generated (gitignored): replace whatever it has.
  const programsFile = `${home}/programs.json`;
  await writeTextFile(programsFile, JSON.stringify(programsFrom(m.base, next), null, 2) + "\n", await read(programsFile));
  setShared(PROFILE_SAVED, Date.now());
}

// After each change: save it (one save after another, so a quick second change can't race the first).
export function changed(m, cx) {
  cx.notify();
  if (m.error) return;
  m.queue = (m.queue ?? Promise.resolve()).then(() => persist(m)).then(
    () => { m.saveError = null; },
    (err) => { m.saveError = `Couldn't save: ${String(err).slice(0, 160)}. Close Settings and open it again.`; },
  );
  cx.spawn(async (cx) => { await m.queue; cx.notify(); });
}

// Where these settings live, and a problem loading or saving them.
export const status = (m, t) => v_flex().gap(4).pb(6)
  .child(note(t, `This computer's, in ${m.where}${m.profile ? "" : " (made by your first change)"}. Changes save as you make them.`))
  .when(Boolean(m.error ?? m.saveError), (el) => el.child(note(t, m.error ?? m.saveError, t.blocked)));


// Accounts' folders in home that aren't accounts yet (Accounts' Find button): .claude* and .codex*,
// listed by a shell (Git's bash on Windows). m.found: the result, [] when there's nothing new.
export function findAccounts(m, cx) {
  if (m.finding) return;
  m.finding = true;
  cx.notify();
  cx.spawn(async (cx) => {
    const shell = window()?.platform === "windows" ? "gitbash" : "sh";
    const r = await exec(shell, ["-c", 'ls -1dp "$HOME"/.claude* "$HOME"/.codex* 2>/dev/null; true'], { timeout: 8000 }).catch(() => null);
    m.found = r ? foundAccounts((r.stdout ?? "").split(/\r?\n/).filter(Boolean), m.list) : null;
    m.findError = r ? null : "Couldn't list your home folder.";
    m.finding = false;
    cx.notify();
  });
}
