// falcon-sidebar's data: each machine's folders, its file and the shared copy; machine states; space
// colors; starting a new space in a folder.
//   A machine's folders live in ~/.config/falconherd-folders.json in its own home, so every screen
//   showing its spaces shows the same: { list: [{ id, name, color, folded, start, rules }], of:
//   { spaceId (as that machine names it): folderId | "" }, at }. While Herdr runs, shared
//   "falcon-sidebar.folders" holds them per machine ("" is this computer), so every part sees a change at once.
import { spaces, exec, hc, readTextFile, writeTextFile, shared, setShared, home, run, appHome } from "herdr";
import { PROFILE_SAVED } from "./core.js";

export const FOLDERS = "falcon-sidebar.folders";
export const DISCONNECTED = "falcon-sidebar.disconnected";      // name -> { target, session }: machines put away from their menu
export const MACHINES_CHANGED = "falcon-sidebar.machines-changed"; // set when the machine menu changed hc's machines
export const ASK_NEW = "falcon-sidebar.ask-new";                 // { machine, folder, at }: a popup asks the list to start a space
export const NEW = "falcon-sidebar.new";                         // { machine, folder, before, until }: a new space to place
export const COLORS = "space.colors";                   // space -> color (the agents list reads it too)
export const ERROR = "falcon-sidebar.error";                      // the last thing that failed, for Settings / debugging
const FILE = ".config/falconherd-folders.json";
const OLD_DISCONNECTED = "space-folders.disconnected";

export const keyOf = (machine) => machine ?? "";
export const localId = (s) => (s.machine && s.id.startsWith(`${s.machine}/`) ? s.id.slice(s.machine.length + 1) : s.id);
export const foldersOf = (machine) => (shared(FOLDERS) ?? {})[keyOf(machine)] ?? { list: [], of: {}, at: 0 };

// Once: machines the old sidebar had put away.
export function migrate() {
  if (shared(DISCONNECTED) == null && shared(OLD_DISCONNECTED)) setShared(DISCONNECTED, shared(OLD_DISCONNECTED));
}

const homes = new Map();
export async function homeOf(machine) {
  if (!machine) return home().replace(/\\/g, "/");
  if (!homes.has(machine)) {
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine });
    if (r.code !== 0 || !r.stdout.trim()) throw new Error("no home there");
    homes.set(machine, r.stdout.trim());
  }
  return homes.get(machine);
}
export async function expand(machine, path) {
  if (!path?.startsWith("~")) return path;
  return (await homeOf(machine)) + path.slice(1);
}

// Rejects when the file can't be read or isn't JSON: then the list doesn't write over it (a missing
// file is fine: there are no folders there yet).
export async function loadFolders(machine) {
  const file = `${await homeOf(machine)}/${FILE}`;
  const text = await readTextFile(file, { on: machine });
  if (text == null || !text.trim()) return;
  let d;
  try { d = JSON.parse(text); } catch {
    setShared(ERROR, `folders ${keyOf(machine)}: ${FILE} isn't valid JSON; fix or remove it`);
    throw new Error("unreadable folders file");
  }
  if (!d || typeof d !== "object") throw new Error("unreadable folders file");
  if (shared(ERROR)?.startsWith(`folders ${keyOf(machine)}:`)) setShared(ERROR, null);
  const now = foldersOf(machine);
  const next = { list: Array.isArray(d.list) ? d.list : [], of: d.of && typeof d.of === "object" ? d.of : {}, at: Number(d.at) || 0 };
  written.set(keyOf(machine), Math.max(written.get(keyOf(machine)) ?? -1, next.at));
  if (!(shared(FOLDERS) ?? {})[keyOf(machine)] || next.at > now.at) setShared(FOLDERS, { ...(shared(FOLDERS) ?? {}), [keyOf(machine)]: next });
}

// A change goes in the shared copy at once (popups close right away, so they can't wait on a write);
// the spaces list writes each machine's copy to its file when it's newer than what's there.
export function saveFolders(machine, data) {
  setShared(FOLDERS, { ...(shared(FOLDERS) ?? {}), [keyOf(machine)]: { list: data.list, of: data.of, at: Date.now() } });
}

const written = new Map(); // machine key -> the "at" its file has (as far as this copy knows)
const writing = new Set();

async function writeFolders(machine, next) {
  const json = `${JSON.stringify(next, null, 2)}\n`;
  if (!machine) {
    const file = `${await homeOf(null)}/${FILE}`;
    await writeTextFile(file, json, await readTextFile(file));
    return;
  }
  const r = await exec("sh", ["-c", `mkdir -p ~/.config && printf '%s' "$1" > ~/${FILE}.tmp && mv ~/${FILE}.tmp ~/${FILE}`, "sh", json], { on: machine });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
}

const failedAt = new Map();
const RETRY_MS = 10000;
// Called by the spaces list often, for the machines it can reach (keys; "" is this computer):
// writes what changed. A failed write is tried again after a while.
export function persistFolders(reachable) {
  for (const [key, d] of Object.entries(shared(FOLDERS) ?? {})) {
    if (!reachable.has(key) || writing.has(key) || (written.get(key) ?? -1) >= d.at) continue;
    if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_MS) continue;
    writing.add(key);
    writeFolders(key || null, d)
      .then(() => { written.set(key, d.at); failedAt.delete(key); if (shared(ERROR)?.startsWith(`folders ${key}:`)) setShared(ERROR, null); })
      .catch((e) => { failedAt.set(key, Date.now()); setShared(ERROR, `folders ${key}: ${e?.message ?? e}`); })
      .finally(() => writing.delete(key));
  }
}

export const changeFolders = (machine, fn) => saveFolders(machine, fn(foldersOf(machine)));

// A new space, in a folder's start folder; the sidebar puts the first space that appears there.
export async function newSpace(machine, folderId) {
  setShared(NEW, { machine: machine ?? null, folder: folderId ?? null, before: spaces().map((s) => s.id), until: Date.now() + 60000 });
  const start = folderId ? foldersOf(machine).list.find((f) => f.id === folderId)?.start : null;
  const folder = start ? await expand(machine, start).catch(() => null) : null;
  run("space.new", { ...(machine ? { machine } : {}), ...(folder ? { folder } : {}) });
}

// From a popup (which closes before newSpace could finish): the spaces list starts it.
export const askNewSpace = (machine, folderId) => setShared(ASK_NEW, { machine: machine ?? null, folder: folderId ?? null, at: Date.now() });

export async function machineList() {
  const r = await hc(["machine", "ls", "--json"]).catch(() => null);
  try { return (JSON.parse(r?.stdout ?? "{}").machines ?? []).filter((m) => !m.temporary); } catch { return null; }
}

export const newFolderId = () => `f${Date.now().toString(36)}`;

// A machine's color ("" in the profile is this computer; null: automatic), in this computer's
// profile (machines/<profile>.json), where Settings keeps it too; then every copy reloads its looks.
export async function setMachineColor(machine, color) {
  const profile = (await readTextFile(`${appHome()}/machine`))?.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(profile ?? "")) throw new Error("This computer has no profile yet: open Settings once");
  const file = `${appHome()}/machines/${profile}.json`;
  const text = await readTextFile(file);
  const data = text ? JSON.parse(text) : {};
  const key = keyOf(machine);
  const { color: _old, ...rest } = data.machines?.[key] ?? {};
  const looks = { ...(data.machines ?? {}), [key]: color ? { ...rest, color } : rest };
  if (!Object.keys(looks[key]).length) delete looks[key];
  const { machines: _was, ...others } = data;
  const next = { ...others, ...(Object.keys(looks).length ? { machines: looks } : {}) };
  await writeTextFile(file, `${JSON.stringify(next, null, 2)}\n`, text);
  setShared(PROFILE_SAVED, Date.now());
}
