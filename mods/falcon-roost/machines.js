// falcon-roost: what a machine's menu asks for (reconnect, disconnect, connect, update hc, forget),
// done by the spaces list. The menu only asks (shared "roost.machine-ask") and closes: a popup's
// work ends when it closes, and these take seconds (Connect up to 20).
import { hc, run, notify, shared, setShared } from "herdr";
import { DISCONNECTED, MACHINES_CHANGED } from "./store.js";

export const MACHINE_ASK = "roost.machine-ask"; // { name, action, target?, session?, at }
export const LABELS = { reconnect: "Reconnecting…", disconnect: "Disconnecting…", connect: "Connecting…", update: "Updating hc…", forget: "Forgetting…" };

export const askMachine = (name, action, extra = {}) => setShared(MACHINE_ASK, { name, action, ...extra, at: Date.now() });

const lastLine = (text) => String(text ?? "").trim().split("\n").filter(Boolean).pop()?.trim().slice(0, 160) ?? "";
const failed = (title, r) => notify({ title, body: lastLine(r?.stderr || r?.stdout), level: "error", timeout: 7000 });
const hcOr = (args) => hc(args).catch((e) => ({ code: 1, stderr: String(e) }));
const forgetAway = (name) => { const rest = { ...(shared(DISCONNECTED) ?? {}) }; delete rest[name]; setShared(DISCONNECTED, rest); };

// A command that may ask something (a password, a code): run in a hidden terminal; still asking after
// `seconds`, that terminal opens for the person to answer.
async function asking(name, args, seconds, okTitle, label) {
  const made = await hc(["run", "--json", "--bg", "--", "hc", ...args]).catch(() => null);
  let address = null;
  try { address = JSON.parse(made?.stdout ?? "{}").address; } catch { address = null; }
  if (!address) { notify({ title: `${label} failed`, body: "Couldn't start it", level: "error", timeout: 7000 }); return false; }
  await hc(["wait", address, "--timeout", String(seconds)]).catch(() => null);
  let facts = null;
  try { facts = JSON.parse((await hc(["get", address]).catch(() => null))?.stdout ?? "{}"); } catch { facts = null; }
  if (facts?.state === "live") {
    run("terminal.peek", { terminal: address });
    notify({ title: `${name} asks for something`, body: "Answer it in the window that opened", level: "warning", timeout: 7000 });
    return false;
  }
  const line = lastLine((await hc(["read", address]).catch(() => null))?.stdout);
  if (facts?.exit_code === 0) { notify({ title: okTitle, body: line, level: "success", timeout: 3000 }); return true; }
  notify({ title: `${label} failed`, body: line, level: "error", timeout: 7000 });
  return false;
}

const ACTIONS = {
  reconnect: ({ name }) => asking(name, ["machine", "login", name], 8, `${name} reconnected`, "Reconnect"),
  async connect({ name }) {
    const away = (shared(DISCONNECTED) ?? {})[name];
    if (!away) return;
    const ok = await asking(name, ["machine", "add", away.target, "--name", name, ...(away.session ? ["--session", away.session] : [])], 20, `${name} connected`, "Connect");
    if (ok) forgetAway(name);
  },
  async disconnect({ name, target, session }) {
    // Remembered first: it can be connected again even if something stops in between.
    const before = shared(DISCONNECTED) ?? {};
    setShared(DISCONNECTED, { ...before, [name]: { target, session: session ?? null } });
    const r = await hcOr(["machine", "rm", name]);
    if (r.code !== 0) { setShared(DISCONNECTED, before); failed("Disconnect failed", r); return; }
    notify({ title: `${name} disconnected`, body: "Its terminals keep running there. Right-click it to connect again", level: "info", timeout: 5000 });
  },
  async update({ name }) {
    const r = await hcOr(["machine", "update", name]);
    if (r.code === 0) notify({ title: `hc updated on ${name}`, level: "success", timeout: 3000 });
    else failed("Update failed", r);
  },
  async forget({ name }) {
    const r = await hcOr(["machine", "rm", name]);
    if (r.code === 0) { forgetAway(name); notify({ title: `Forgot ${name}`, level: "success", timeout: 3000 }); }
    else failed("Forget failed", r);
  },
};

// The list's part: one ask at a time per machine; `busy` (name -> label) shows on its header.
export async function doMachineAsk(ask, busy) {
  const work = ACTIONS[ask?.action];
  if (!work || !ask.name || busy.has(ask.name)) return;
  busy.set(ask.name, LABELS[ask.action]);
  try { await work(ask); } catch (e) { notify({ title: "That didn't work", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 7000 }); }
  finally { busy.delete(ask.name); setShared(MACHINES_CHANGED, Date.now()); }
}
