/* eslint-disable no-console -- A CLI evaluation prints progress and results. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value)
    ? value
        .map((part: unknown) => {
          const p = object(part);
          return p.type === "text" && typeof p.text === "string" ? p.text : "";
        })
        .join("\n")
    : "";
}
const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!key || !value || !key.startsWith("--")) throw new Error("Use --option value pairs");
  options.set(key.slice(2), value);
}
const known = [
  "extension",
  "models",
  "scenarios",
  "repetitions",
  "concurrency",
  "timeout-ms",
  "output",
  "resume",
  "seed-model",
  "system-prompt",
];
for (const key of options.keys()) if (!known.includes(key)) throw new Error(`Unknown --${key}`);
const extension = resolve(options.get("extension") ?? ".");
const concurrency = Number(options.get("concurrency") ?? 2);
const repetitions = Number(options.get("repetitions") ?? 3);
const timeout = Number(options.get("timeout-ms") ?? 180000);
for (const n of [concurrency, repetitions, timeout])
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("Positive integers required");
const seedModel = options.get("seed-model") ?? "zai/glm-5.3-flash";
const systemPromptOption = options.get("system-prompt");
const systemPromptPath = systemPromptOption ? resolve(systemPromptOption) : null;
const systemPrompt = systemPromptPath ? await readFile(systemPromptPath, "utf8") : null;
const previous: unknown = options.has("resume")
  ? JSON.parse(await readFile(resolve(options.get("resume") ?? ""), "utf8"))
  : null;
const saved = object(previous);
const root =
  typeof saved.root === "string"
    ? saved.root
    : await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "search-recall-"));
const output = resolve(
  options.get("resume") ?? options.get("output") ?? join(root, "results.json"),
);

type Expected = { text: string; ignoreCase: boolean } | null;
type Scenario = {
  id: string;
  kind: "past" | "current" | "negative";
  prompt: string;
  expected: Expected;
};
const scenarios: Scenario[] = [
  {
    id: "P1",
    kind: "past",
    prompt:
      "Last time we settled which port the staging server listens on. Which port was it, and why?",
    expected: { text: "7341", ignoreCase: false },
  },
  {
    id: "P2",
    kind: "past",
    prompt: "Why is stagingPort 7341 in config.json rather than 8080?",
    expected: { text: "VPN", ignoreCase: true },
  },
  {
    id: "P3",
    kind: "past",
    prompt:
      "The deploy script failed again with the same error as before. What fixed it last time?",
    expected: { text: ".deploy/lock", ignoreCase: false },
  },
  {
    id: "P4",
    kind: "current",
    prompt: "What exactly did that command print? Do not run it again.",
    expected: null, // The run's token, generated per run.
  },
  {
    id: "N1",
    kind: "negative",
    prompt: "Create hello.txt containing the word hi.",
    expected: null,
  },
  {
    id: "N2",
    kind: "negative",
    prompt: "Which port does config.json set for staging?",
    expected: { text: "7341", ignoreCase: false },
  },
];
const turn1 = (tokenFile: string) =>
  `Run the shell command \`cat ${tokenFile}\` and reply with done only.`;
const compactInstructions =
  "The summary must be one sentence. Omit every identifier, file path, and command output; say only that a shell command was run.";
const seeds = [
  "For the record: we renamed the `utils` folder to `lib` and moved the date helpers into `lib/dates.ts`. Reply with OK only.",
  "Decision for the record: the staging server listens on port 7341, because 8080 collides with the VPN client on our laptops. Reply with OK only.",
  "For the record: `deploy.sh` failed with ERR_LOCKFILE_STALE. Deleting `.deploy/lock` and rerunning fixed it. Reply with OK only.",
];
const selected = (options.get("scenarios") ?? scenarios.map((s) => s.id).join(",")).split(",");
for (const id of selected)
  if (!scenarios.some((s) => s.id === id))
    throw new Error(`Unknown scenario ${id}; use ${scenarios.map((s) => s.id).join(",")}`);
if (
  previous &&
  (saved.extension !== extension ||
    JSON.stringify(saved.selected) !== JSON.stringify(selected) ||
    saved.repetitions !== repetitions ||
    saved.modelSelection !== (options.get("models") ?? null) ||
    saved.seedModel !== seedModel ||
    saved.systemPromptPath !== systemPromptPath ||
    saved.systemPrompt !== systemPrompt)
)
  throw new Error("Resume options differ from saved invocation");

// Discover only provider-registering entrypoints from installed npm packages, not their tools.
const agentHome = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
// pi's default session storage marks a bypass, unless this invocation's own root lies inside it.
const agentSessions = [join(agentHome, "sessions"), ".pi/agent/sessions"].filter(
  (marker) => !root.includes(marker),
);
const settings = object(JSON.parse(await readFile(join(agentHome, "settings.json"), "utf8")));
const providerExtensions: string[] = [];
if (Array.isArray(settings.packages))
  for (const pkg of settings.packages) {
    if (typeof pkg !== "string" || !pkg.startsWith("npm:")) continue;
    const name = pkg.slice(4).replace(/(?<!^)@[^/]*$/, "");
    const packageRoot = join(agentHome, "npm/node_modules", name);
    const manifest = object(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")));
    const entries = object(manifest.pi).extensions;
    if (Array.isArray(entries))
      for (const entry of entries) {
        if (typeof entry !== "string") continue;
        const path = resolve(packageRoot, entry);
        if (/\bregisterProvider\s*\(/.test(await readFile(path, "utf8")))
          providerExtensions.push(path);
      }
  }
const extensionArgs = [
  "-ne",
  "-e",
  extension,
  ...providerExtensions.flatMap((p) => ["-e", p]),
  "-nc",
  "-ns",
  "-np",
  // Trust the run directory's own .pi/settings.json (P4 compaction settings) regardless of defaults.
  "--approve",
];

type Exit = { code: number | null; timedOut: boolean; stdout: string; stderr: string };
function launch(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onLine?: (line: string) => void,
) {
  const proc = spawn("pi", args, {
    cwd,
    env,
    detached: true,
    stdio: [onLine ? "pipe" : "ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let pending = "";
  let timedOut = false;
  let closed = false;
  const done = new Promise<Exit>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    }, timeout);
    proc.stdout.on("data", (chunk: Buffer) => {
      const piece = chunk.toString();
      stdout += piece;
      if (!onLine) return;
      // RPC framing splits records on LF only.
      pending += piece;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) if (part.trim()) onLine(part.replace(/\r$/, ""));
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      closed = true;
      resolveExit({ code, timedOut, stdout, stderr });
    });
  });
  return {
    proc,
    done,
    exited: () => closed,
    send(command: Record<string, unknown>) {
      proc.stdin?.write(`${JSON.stringify(command)}\n`);
    },
  };
}
async function printRun(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return await launch(args, cwd, env).done;
}
function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_DENT_")) delete env[key];
  Object.assign(env, {
    PI_DENT_TASKS_DB: join(dir, "tasks.sqlite"),
    PI_DENT_FLEET_DB: join(dir, "fleet.sqlite"),
    PI_DENT_SEARCH_DB: join(dir, "search.sqlite"),
    PI_DENT_STATE_DIR: join(dir, "state"),
    PI_TELEMETRY: "0",
  });
  return env;
}
async function prepareCwd(dir: string) {
  await mkdir(join(dir, ".pi/pi-dent"), { recursive: true });
  // Replace the object-valued global plugin map rather than deep-merging it.
  await writeFile(join(dir, ".pi/pi-dent/pi-dent.conf"), JSON.stringify({ plugins: [] }));
}
async function sessionFiles(dir: string) {
  return (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
}

// Seed the earlier sessions once per invocation; a resume reuses them.
const seedRoot = join(root, "seed");
const templateDir = join(seedRoot, "sessions");
async function seed() {
  if (Array.isArray(saved.seedSessions) && saved.seedSessions.length === seeds.length) {
    const names = saved.seedSessions.filter((n): n is string => typeof n === "string");
    if (names.length === seeds.length) return names;
  }
  const cwd = join(seedRoot, "cwd");
  await prepareCwd(cwd);
  await mkdir(templateDir, { recursive: true });
  const names: string[] = [];
  for (const [i, prompt] of seeds.entries()) {
    const sessions = join(seedRoot, `sessions-${i + 1}`);
    await mkdir(sessions);
    const result = await printRun(
      [
        ...extensionArgs,
        "--session-dir",
        sessions,
        "--model",
        seedModel,
        "--mode",
        "json",
        "-p",
        prompt,
      ],
      cwd,
      isolatedEnv(join(seedRoot, `env-${i + 1}`)),
    );
    await writeFile(join(seedRoot, `seed-${i + 1}.stdout.jsonl`), result.stdout);
    await writeFile(join(seedRoot, `seed-${i + 1}.stderr.txt`), result.stderr);
    const files = await sessionFiles(sessions);
    if (result.timedOut || result.code !== 0 || files.length !== 1 || !files[0])
      throw new Error(
        `Seed run ${i + 1} on ${seedModel} failed: ${result.timedOut ? "timeout" : `exit ${result.code}`}, ${files.length} session files (want 1) in ${sessions}. stderr: ${result.stderr}`,
      );
    const errors = score(await readFile(join(sessions, files[0]), "utf8"), "N1", null).parentErrors;
    if (errors.length) throw new Error(`Seed run ${i + 1} on ${seedModel}: ${errors.join("; ")}`);
    await copyFile(join(sessions, files[0]), join(templateDir, files[0]));
    names.push(files[0]);
  }
  return names;
}

type SearchCall = {
  arguments: Record<string, unknown>;
  isError: boolean | null;
  error: string | null;
};
type ToolCall = { id: unknown; name: string; arguments: Record<string, unknown> } & Omit<
  SearchCall,
  "arguments"
>;
const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim());
const tilde = (v: unknown) => typeof v === "string" && v.trim().startsWith("~");
export function score(transcript: string, scenario: string, token: string | null) {
  const entries: Record<string, unknown>[] = transcript
    .split("\n")
    .filter(Boolean)
    .map((line) => object(JSON.parse(line)));
  // P4 scores only what follows the compaction; turn 1 is setup.
  let start = 0;
  let kept = -1;
  entries.forEach((e, i) => {
    if (e.type !== "compaction") return;
    start = i + 1;
    kept = entries.findIndex((k) => k.id === e.firstKeptEntryId);
  });
  // Entries a compaction keeps verbatim stay in the model's context.
  const tokenKept =
    token !== null &&
    kept >= 0 &&
    entries.slice(kept, start - 1).some((e) => JSON.stringify(e).includes(token));
  const calls: ToolCall[] = [];
  const parentErrors: string[] = [];
  let systemPreamble: string | null = null;
  let finalText = "";
  let tokenInToolResult = false;
  let tokenInAssistantText = false;
  let compactionSummary: string | null = null;
  for (const [i, entry] of entries.entries()) {
    if (entry.type === "compaction" && typeof entry.summary === "string")
      compactionSummary = entry.summary;
    const message = object(entry.message);
    if (message.role === "system" && systemPreamble === null) {
      const preamble = object(message.sections).preamble;
      systemPreamble = typeof preamble === "string" ? preamble : text(message.content);
    }
    if (i < start) {
      if (token && message.role === "toolResult" && JSON.stringify(message.content).includes(token))
        tokenInToolResult = true;
      if (token && message.role === "assistant" && text(message.content).includes(token))
        tokenInAssistantText = true;
      continue;
    }
    if (message.role === "assistant") {
      if (typeof message.errorMessage === "string") parentErrors.push(message.errorMessage);
      const said = text(message.content);
      if (said.trim()) finalText = said;
      if (Array.isArray(message.content))
        for (const value of message.content) {
          const part = object(value);
          if (part.type === "toolCall" && typeof part.name === "string")
            calls.push({
              id: part.id,
              name: part.name,
              arguments: object(part.arguments),
              isError: null,
              error: null,
            });
        }
    }
    if (message.role === "toolResult") {
      const call = calls.find((c) => c.id === message.toolCallId);
      if (call) {
        call.isError = message.isError === true;
        call.error = call.isError ? text(message.content) : null;
      }
    }
  }
  return {
    calls,
    parentErrors,
    systemPreamble,
    finalText,
    tokenInToolResult,
    tokenInAssistantText,
    tokenKept,
    compactionSummary,
    scenario,
  };
}
function verdict(
  scored: ReturnType<typeof score>,
  scenario: Scenario,
  token: string | null,
  sessionsDirs: string[],
) {
  const searches = scored.calls.filter((c) => c.name === "Search");
  const ok = searches.filter((c) => c.isError === false);
  const reachedProject = ok.some(
    (c) =>
      c.arguments.scope === "project" ||
      c.arguments.scope === "project-trees" ||
      tilde(c.arguments.session) ||
      tilde(c.arguments.address) ||
      tilde(c.arguments.after) ||
      (typeof c.arguments.session === "string" && c.arguments.session.trim().startsWith("/")),
  );
  const searchedSelf = ok.some(
    (c) =>
      c.arguments.action === "find" &&
      (blank(c.arguments.session) || c.arguments.session === "self") &&
      (blank(c.arguments.scope) || c.arguments.scope === "session" || c.arguments.scope === "tree"),
  );
  const expected: Expected =
    scenario.id === "P4" && token ? { text: token, ignoreCase: false } : scenario.expected;
  const answered = expected
    ? expected.ignoreCase
      ? scored.finalText.toLowerCase().includes(expected.text.toLowerCase())
      : scored.finalText.includes(expected.text)
    : null;
  const bypass = scored.calls.some((c) => {
    if (c.name === "Search") return false;
    const args = JSON.stringify(c.arguments);
    return args.includes(".jsonl") || sessionsDirs.some((d) => args.includes(d));
  });
  const askedUser = scored.calls.length === 0 && answered !== true;
  const pass =
    scenario.kind === "past"
      ? reachedProject && answered === true
      : scenario.kind === "current"
        ? searchedSelf && answered === true
        : searches.length === 0 && answered !== false;
  return {
    searchCalls: searches.map((c) => ({
      arguments: c.arguments,
      isError: c.isError,
      error: c.error,
    })),
    otherTools: scored.calls.filter((c) => c.name !== "Search").map((c) => c.name),
    reachedProject,
    searchedSelf,
    answered,
    bypass,
    askedUser,
    pass,
  };
}

// P4: turn 1 prints a token only into a tool result, compaction drops it, turn 2 asks for it.
async function compactionRun(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  file: string,
  token: string,
) {
  const records: Record<string, unknown>[] = [];
  const unparsed: string[] = [];
  let wake = () => {};
  const child = launch(args, cwd, env, (line) => {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      unparsed.push(line); // Reported as the run's reason below.
      wake();
      return;
    }
    const r = object(record);
    records.push(r);
    if (
      r.type === "extension_ui_request" &&
      ["select", "confirm", "input", "editor"].includes(String(r.method))
    )
      child.send({ type: "extension_ui_response", id: r.id, cancelled: true });
    wake();
  });
  void child.done.finally(() => wake());
  async function waitFor(match: (r: Record<string, unknown>) => boolean, from: number) {
    for (;;) {
      const found = records.slice(from).find(match);
      if (found) return found;
      if (child.exited()) return null;
      await new Promise<void>((done) => {
        wake = done;
      });
    }
  }
  async function prompt(id: string, message: string): Promise<string | null> {
    const from = records.length;
    child.send({ id, type: "prompt", message });
    const response = await waitFor((r) => r.type === "response" && r.id === id, from);
    if (!response) return `pi exited before answering ${id}`;
    if (response.success !== true) return `${id} rejected: ${String(response.error)}`;
    const disposition = object(response.data).disposition;
    if (disposition !== "started") return `${id} not started: ${String(disposition)}`;
    return (await waitFor((r) => r.type === "agent_settled", from))
      ? null
      : `pi exited during ${id}`;
  }
  let reason = await prompt("turn1", turn1(file));
  // The answer to turn 2 must come from the transcript, not from rerunning the command.
  await rm(file, { force: true });
  let summary: string | null = null;
  if (!reason) {
    const from = records.length;
    child.send({ id: "compact", type: "compact", customInstructions: compactInstructions });
    const response = await waitFor((r) => r.type === "response" && r.id === "compact", from);
    if (response === null) reason = "pi exited during compaction";
    else if (response.success === true) {
      const s = object(response.data).summary;
      summary = typeof s === "string" ? s : null;
      if (summary === null) reason = "compaction returned no summary";
    } else reason = `compaction failed: ${String(response.error)}`;
  }
  if (!reason && summary !== null && !summary.includes(token))
    reason = await prompt("turn2", scenarios.find((s) => s.id === "P4")?.prompt ?? "");
  child.proc.stdin?.end();
  const exit = await child.done;
  if (!reason && unparsed.length) reason = `unparsed RPC output: ${unparsed[0]}`;
  return { exit, reason, summary };
}

type Run = Awaited<ReturnType<typeof run>>;
async function run(model: string, scenarioId: string, repetition: number) {
  const scenario = scenarios.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`Missing scenario ${scenarioId}`);
  const dir = await mkdtemp(join(root, "run-"));
  // The cwd is beside the sessions directory, not above it, as with pi's own session storage.
  const cwd = join(dir, "cwd");
  await prepareCwd(cwd);
  await writeFile(join(cwd, "config.json"), `${JSON.stringify({ stagingPort: 7341 })}\n`);
  const sessions = join(dir, "sessions");
  await mkdir(sessions);
  for (const name of seedSessions) await copyFile(join(templateDir, name), join(sessions, name));
  const env = isolatedEnv(dir);
  const args = [
    ...extensionArgs,
    "--session-dir",
    sessions,
    "--model",
    model,
    ...(systemPromptPath ? ["--system-prompt", systemPromptPath] : []),
  ];
  let token: string | null = null;
  let exit: Exit;
  let driverReason: string | null = null;
  let summary: string | null = null;
  if (scenario.id === "P4") {
    // Summarize the whole history so the token can only survive in the raw transcript.
    await writeFile(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({ compaction: { keepRecentTokens: 0 } }),
    );
    // A build label, not something a model takes for a credential and declines to repeat.
    token = `kestrel-${randomBytes(4).toString("hex")}`;
    const file = join(dir, "build-label.txt");
    await writeFile(file, `${token}\n`);
    const result = await compactionRun([...args, "--mode", "rpc"], cwd, env, file, token);
    ({ exit } = result);
    driverReason = result.reason;
    summary = result.summary;
  } else exit = await printRun([...args, "--mode", "json", "-p", scenario.prompt], cwd, env);
  await writeFile(join(dir, "stdout.jsonl"), exit.stdout);
  await writeFile(join(dir, "stderr.txt"), exit.stderr);
  const own = (await sessionFiles(sessions)).filter((f) => !seedSessions.includes(f));
  const sessionFile = own.length === 1 && own[0] ? join(sessions, own[0]) : null;
  const scored = score(sessionFile ? await readFile(sessionFile, "utf8") : "", scenario.id, token);
  const sessionsDirs = [sessions, await realpath(sessions), "../sessions", ...agentSessions];
  const result = verdict(scored, scenario, token, sessionsDirs);
  const systemPromptApplied =
    systemPrompt === null ? null : scored.systemPreamble?.trim() === systemPrompt.trim();
  function unscored() {
    if (exit.timedOut) return "timeout";
    if (scored.parentErrors.length) return scored.parentErrors.join("; ");
    if (driverReason) return driverReason;
    if (summary !== null && token && summary.includes(token)) return "token survived compaction";
    if (scored.tokenKept) return "token kept after compaction";
    if (exit.code !== 0) return `exit ${exit.code}: ${exit.stderr || exit.stdout}`;
    if (sessionFile === null) return `missing session file (${own.length} new files)`;
    if (systemPromptApplied === false) return "system prompt not applied";
    if (token && !scored.tokenInToolResult) return "turn 1 did not print the token";
    return null;
  }
  const reason = unscored();
  return {
    model,
    scenario: scenario.id,
    repetition,
    dir,
    sessionFile,
    reason,
    ...result,
    finalText: scored.finalText,
    systemPromptApplied,
    token,
    compactionSummary: summary ?? scored.compactionSummary,
    tokenInTurn1Text: token ? scored.tokenInAssistantText : null,
  };
}
function isRun(value: unknown): value is Run {
  const r = object(value);
  return (
    typeof r.model === "string" &&
    typeof r.scenario === "string" &&
    typeof r.repetition === "number" &&
    Array.isArray(r.searchCalls)
  );
}

let available: string[] = [];
if (options.get("models") === "all") {
  // Discovery only: no prompt is sent and no session is created.
  const listing = await printRun([...extensionArgs, "--list-models"], root, process.env);
  if (listing.code !== 0) throw new Error(listing.stderr);
  available = listing.stdout.split("\n").flatMap((line) => {
    const match = /^(\S+)\s+(\S+)\s+\S+\s+\S+\s+(?:yes|no)\s+(?:yes|no)\s*$/.exec(line);
    return match ? [`${match[1]}/${match[2]}`] : [];
  });
  if (!available.length) throw new Error("Could not parse pi --list-models");
}
const models =
  options.get("models") === "all"
    ? available
    : (options.get("models") ?? "zai/glm-5.3-flash").split(",");
const seedSessions = await seed();
console.error(`Seed sessions in ${templateDir}: ${seedSessions.join(", ")}`);
const runs: Run[] = Array.isArray(saved.runs) ? saved.runs.filter(isRun) : [];
if (Array.isArray(saved.runs) && saved.runs.length !== runs.length)
  throw new Error("Invalid saved run");
const metadata = {
  extension,
  root,
  models,
  modelSelection: options.get("models") ?? null,
  scenarios,
  turn1: turn1("<token file>"),
  compactInstructions,
  seeds,
  seedModel,
  seedSessions,
  templateDir,
  selected,
  repetitions,
  systemPromptPath,
  systemPrompt,
  providerExtensions,
};
let saving = Promise.resolve();
function save() {
  saving = saving.then(async () => {
    await writeFile(`${output}.tmp`, JSON.stringify({ ...metadata, runs }, null, 2));
    await rename(`${output}.tmp`, output);
  });
  return saving;
}
await save();
// A scenario-level outcome, not a sign the model is unavailable.
const scenarioReasons = [
  "token survived compaction",
  "token kept after compaction",
  "turn 1 did not print the token",
];
await Promise.all(
  [...new Set(models.map((m) => m.split("/")[0]))].map(async (provider) => {
    const jobs = models
      .filter((m) => m.split("/")[0] === provider)
      .flatMap((model) =>
        selected.flatMap((scenario) =>
          Array.from({ length: repetitions }, (_, i) => ({ model, scenario, repetition: i + 1 })),
        ),
      );
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          const job = jobs.shift();
          if (!job) break;
          if (
            runs.some(
              (r) =>
                r.model === job.model &&
                r.scenario === job.scenario &&
                r.repetition === job.repetition,
            )
          )
            continue;
          const failed = runs.find(
            (r) =>
              r.model === job.model && r.reason !== null && !scenarioReasons.includes(r.reason),
          );
          const result: Run = failed
            ? {
                ...failed,
                ...job,
                dir: "",
                sessionFile: null,
                searchCalls: [],
                otherTools: [],
                reachedProject: false,
                searchedSelf: false,
                answered: null,
                bypass: false,
                askedUser: false,
                pass: false,
                finalText: "",
                token: null,
                compactionSummary: null,
                tokenInTurn1Text: null,
                reason: `not attempted after unavailable run: ${failed.reason}`,
              }
            : await run(job.model, job.scenario, job.repetition);
          runs.push(result);
          await save();
          console.error(
            `${result.model} ${result.scenario} #${result.repetition}: ${result.reason ?? `pass=${result.pass} search=${result.searchCalls.length} answered=${result.answered}`}`,
          );
        }
      }),
    );
  }),
);
function row(label: string, group: Run[]) {
  const scored = group.filter((r) => r.reason === null);
  const reasons: Record<string, number> = {};
  for (const r of group) if (r.reason) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  return {
    label,
    runs: group.length,
    pass: `${scored.filter((r) => r.pass).length}/${scored.length}`,
    searched: `${scored.filter((r) => r.searchCalls.length > 0).length}/${scored.length}`,
    answered: `${scored.filter((r) => r.answered === true).length}/${scored.length}`,
    bypass: scored.filter((r) => r.bypass).length,
    unscored: group.length - scored.length,
    reasons: JSON.stringify(reasons),
  };
}
console.table(
  models.flatMap((model) => [
    ...selected.map((s) =>
      row(
        `${model} ${s}`,
        runs.filter((r) => r.model === model && r.scenario === s),
      ),
    ),
    row(
      `${model} TOTAL`,
      runs.filter((r) => r.model === model),
    ),
  ]),
);
await save();
console.log(JSON.stringify({ output }));
