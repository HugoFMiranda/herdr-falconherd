// claude-usage <account> [config dir]: ask the Claude CLI for this account's usage limits through the
// Agent SDK's get_usage control request (as T3 Code does), and save them for the Herdr mods at
// ~/.cache/herdr-session/accounts/claude-<account>.json. The CLI does the authentication; this
// script never reads credentials. The prompt stream never yields, so no prompt reaches the API.
// The config dir is the account's folder in home (the mods pass this machine's); work and personal
// have defaults.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fromSdkUsage, modelsFrom } from "./session-core.js";

const ACCOUNT_DIRS = { work: ".claude", personal: ".claude_personal" };
const ACCOUNT_ID = /^[A-Za-z0-9_-]+$/;
const DIR_NAME = /^\.[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

// CLAUDE_CONFIG_DIR for an account, or null for the default ~/.claude.
export function configDirFor(account, dir, home) {
  const name = dir ?? ACCOUNT_DIRS[account];
  if (!name) throw new Error(`no config dir for account: ${account}`);
  if (!DIR_NAME.test(name) || name.includes("..")) throw new Error(`not a folder in home: ${name}`);
  return name === ".claude" ? null : join(home, name);
}
const TIMEOUT_MS = 30000;

export function writeReading(cacheRoot, account, reading) {
  if (!ACCOUNT_ID.test(account ?? "")) throw new Error(`not an account id: ${account}`);
  if (!reading) throw new Error("no usage reading");
  const dir = join(cacheRoot, "accounts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `claude-${account}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(reading));
  renameSync(`${path}.tmp`, path);
}

// The account's models (the SDK's initialization list) for the menus, beside its reading:
// accounts/claude-<account>.models.json. No list keeps the last one.
export function writeModels(cacheRoot, account, sdkModels) {
  if (!ACCOUNT_ID.test(account ?? "")) throw new Error(`not an account id: ${account}`);
  const models = modelsFrom(sdkModels);
  if (!models) return;
  const dir = join(cacheRoot, "accounts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `claude-${account}.models.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(models));
  renameSync(`${path}.tmp`, path);
}

// { usage, models }: the usage reading and the account's models, from one session start.
export async function probe(env, timeoutMs = TIMEOUT_MS) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  const aborted = new Promise((resolve) => abortController.signal.addEventListener("abort", resolve));
  // On Windows, sh's answer is an MSYS path without .exe, which the SDK can't start.
  const claude = process.platform === "win32"
    ? execFileSync("where", ["claude"], { env, encoding: "utf8" }).split(/\r?\n/)[0].trim()
    : execFileSync("sh", ["-c", "command -v claude"], { env, encoding: "utf8" }).trim();
  const q = query({
    // Never yields: the session starts, answers control requests, and sends nothing to the model.
    prompt: (async function* () { await aborted; })(),
    options: { abortController, env, pathToClaudeCodeExecutable: claude, persistSession: false, settingSources: [] },
  });
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const init = await q.initializationResult();
    const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    return { usage, models: init?.models ?? null };
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
}

async function main(account, dir) {
  let config;
  try {
    if (!ACCOUNT_ID.test(account ?? "")) throw new Error("no account");
    config = configDirFor(account, dir, homedir());
  } catch {
    console.error("usage: claude-usage <account> [config dir]   (work and personal know their dir)");
    process.exit(2);
  }
  const env = { ...process.env };
  if (config) env.CLAUDE_CONFIG_DIR = config;
  else delete env.CLAUDE_CONFIG_DIR;
  const root = process.env.HERDR_SESSION_CACHE || join(homedir(), ".cache", "herdr-session");
  const { usage, models } = await probe(env);
  writeModels(root, account, models);
  const reading = fromSdkUsage(usage, Date.now());
  writeReading(root, account, reading);
  console.log(JSON.stringify(reading));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv[2], process.argv[3]).then(() => process.exit(0), (e) => { console.error(`claude-usage: ${e.message ?? e}`); process.exit(1); });
}
