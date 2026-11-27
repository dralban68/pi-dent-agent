/* eslint-disable no-console -- A CLI evaluation prints progress and results. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}
function text(value: unknown): string {
  return Array.isArray(value)
    ? value.map((part: unknown) => object(part).text ?? "").join("\n")
    : "";
}
const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!key || !value || !key.startsWith("--")) throw new Error("Use --option value pairs");
  options.set(key.slice(2), value);
}
const extension = resolve(options.get("extension") ?? ".");
const childModel = options.get("child-model") ?? "deepseek/deepseek-flash";
const concurrency = Number(options.get("concurrency") ?? 2);
const repetitions = Number(options.get("repetitions") ?? 3);
const timeout = Number(options.get("timeout-ms") ?? 120000);
for (const n of [concurrency, repetitions, timeout])
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("Positive integers required");
const previous: unknown = options.has("resume")
  ? JSON.parse(await readFile(resolve(options.get("resume") ?? ""), "utf8"))
  : null;
const saved = object(previous);
const root =
  typeof saved.root === "string"
    ? saved.root
    : await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agent-dispatch-"));
const output = resolve(
  options.get("resume") ?? options.get("output") ?? join(root, "results.json"),
);
const alternateModel = options.get("alternate-model") ?? "anthropic/claude-haiku-5-5";
// Discover only provider-registering entrypoints from installed npm packages, not their tools.
const agentHome = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
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
const extensionArgs = ["-ne", "-e", extension, ...providerExtensions.flatMap((p) => ["-e", p])];
const scenarios = [
  `Have a separate ad-hoc agent running on ${childModel} reply with the single word pong. Tell me its answer.`,
  "Have a separate ad-hoc agent reply with the single word pong. Tell me its answer.",
  "Use the summarizer agent to summarize 'The sky is blue' in one word. Tell me its answer.",
  "Have a separate ad-hoc agent remember the word violet and acknowledge in one word. Then send that same agent a follow-up asking which word it remembers. Tell me its answer.",
  `Use the summarizer agent running on ${childModel} to summarize 'The sky is blue' in one word. Tell me its answer.`,
  `Split this job across three separate workers in parallel, all running on ${childModel}: one says red, one says green, one says blue. Launch them together and report their answers.`,
  `Ask ${childModel} to reply with the single word pong. Tell me its answer.`,
  `Have a separate ad-hoc agent running on ${childModel} remember the word violet and acknowledge in one word. Then ask that same agent to answer on ${alternateModel}: which word does it remember? Tell me its answer.`,
  "Use the summarizer agent to summarize 'The sky is blue' in one word. Then send that same agent a follow-up asking it to repeat its answer. Tell me the final answer.",
];
const selected = (options.get("scenarios") ?? "1,2,3,4,5,6,7,8,9").split(",").map(Number);
if (selected.some((s) => !scenarios[s - 1])) throw new Error("Scenarios must be 1..9");
if (
  previous &&
  (saved.extension !== extension ||
    saved.childModel !== childModel ||
    saved.alternateModel !== alternateModel ||
    JSON.stringify(saved.selected) !== JSON.stringify(selected) ||
    saved.repetitions !== repetitions ||
    saved.modelSelection !== options.get("models"))
)
  throw new Error("Resume options differ from saved invocation");
async function command(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return await new Promise<{
    code: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  }>((done, reject) => {
    const proc = spawn("pi", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    }, timeout);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
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
      done({ code, timedOut, stdout, stderr });
    });
  });
}
// Discovery only: no prompt is sent and no session is created.
const listing = await command([...extensionArgs, "--list-models"], root);
if (listing.code !== 0) throw new Error(listing.stderr);
const available = listing.stdout.split("\n").flatMap((line) => {
  const match = /^(\S+)\s+(\S+)\s+\S+\s+\S+\s+(?:yes|no)\s+(?:yes|no)\s*$/.exec(line);
  return match ? [`${match[1]}/${match[2]}`] : [];
});
if (!available.length) throw new Error("Could not parse pi --list-models");
const models =
  options.get("models") === "all"
    ? available
    : (options.get("models") ?? "anthropic/claude-haiku-5-5").split(",");
export function score(transcript: string) {
  const calls: {
    id: unknown;
    arguments: Record<string, unknown>;
    accepted: boolean | null;
    error: string | null;
    identities: unknown[];
  }[] = [];
  const parentErrors: string[] = [];
  for (const line of transcript.split("\n").filter(Boolean)) {
    const entry: unknown = JSON.parse(line);
    const message = object(object(entry).message);
    if (message.role === "assistant") {
      if (typeof message.errorMessage === "string") parentErrors.push(message.errorMessage);
      if (Array.isArray(message.content))
        for (const value of message.content) {
          const part = object(value);
          if (part.type === "toolCall" && part.name === "Agent")
            calls.push({
              id: part.id,
              arguments: object(part.arguments),
              accepted: null,
              error: null,
              identities: [],
            });
        }
    }
    if (message.role === "toolResult" && message.toolName === "Agent") {
      const call = calls.find((c) => c.id === message.toolCallId);
      if (!call) throw new Error("Unmatched Agent result");
      const error = text(message.content);
      const records = object(message.details).results;
      call.identities = Array.isArray(records) ? records.map((r: unknown) => object(r).agent) : [];
      const planFailure =
        Array.isArray(records) &&
        records.some((r: unknown) => object(r).failurePhase === "plan-resolution");
      const rejection =
        /neither agent nor prompt|both agent and prompt|unknown agent|resume (?:must|source)|in-flight dispatch|exactly one of agent|Validation failed for tool/.test(
          error,
        );
      call.accepted = message.isError === true && (planFailure || rejection) ? false : true;
      call.error = message.isError === true ? error : null;
    }
  }
  return { calls, parentErrors };
}
type Run = Awaited<ReturnType<typeof run>>;
async function run(model: string, scenario: number, repetition: number) {
  const dir = await mkdtemp(join(root, "run-"));
  const layer = join(dir, ".pi/pi-dent");
  await mkdir(join(layer, "agents"), { recursive: true });
  await mkdir(join(dir, "sessions"));
  // Replace the object-valued global plugin map rather than deep-merging it.
  await writeFile(
    join(layer, "pi-dent.conf"),
    JSON.stringify({ plugins: [], agentAbsoluteTimeoutMs: 60000 }),
  );
  for (const name of ["reviewer", "summarizer"])
    await writeFile(
      join(layer, "agents", `${name}.md`),
      `---\nname: ${name}\ndescription: ${name === "summarizer" ? "Summarizes short text" : "Reviews short text"}\n---\nAnswer the task briefly. Do not use tools.\n`,
    );
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_DENT_")) delete env[key];
  Object.assign(env, {
    PI_DENT_TASKS_DB: join(dir, "tasks.sqlite"),
    PI_DENT_FLEET_DB: join(dir, "fleet.sqlite"),
    PI_DENT_SEARCH_DB: join(dir, "search.sqlite"),
    PI_DENT_STATE_DIR: join(dir, "state"),
    PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS: "60000",
    PI_TELEMETRY: "0",
  });
  const prompt = scenarios[scenario - 1];
  if (!prompt) throw new Error("Missing scenario");
  const result = await command(
    [
      ...extensionArgs,
      "-nc",
      "-ns",
      "-np",
      "--session-dir",
      join(dir, "sessions"),
      "--model",
      model,
      "--mode",
      "json",
      "-p",
      prompt,
    ],
    dir,
    env,
  );
  await writeFile(join(dir, "stdout.jsonl"), result.stdout);
  await writeFile(join(dir, "stderr.txt"), result.stderr);
  const files = (await readdir(join(dir, "sessions"))).filter((f) => f.endsWith(".jsonl"));
  const transcript =
    files.length === 1 ? await readFile(join(dir, "sessions", files[0] ?? ""), "utf8") : "";
  const scored = score(transcript);
  const reason = result.timedOut
    ? "timeout"
    : scored.parentErrors.length
      ? scored.parentErrors.join("; ")
      : result.code === 0
        ? scored.calls.length > 0
          ? scored.calls.some((c) => c.accepted === null)
            ? "Agent result missing"
            : null
          : "no Agent call"
        : `exit ${result.code}: ${result.stderr || result.stdout}`;
  const requestedModel = [1, 5, 6, 7, 8].includes(scenario);
  const named = [3, 5, 9].includes(scenario);
  return {
    model,
    scenario,
    repetition,
    dir,
    reason,
    ...scored,
    firstAccepted: reason ? null : (scored.calls[0]?.accepted ?? null),
    allAccepted: reason ? null : scored.calls.every((c) => c.accepted === true),
    fieldsCorrect: reason
      ? null
      : scored.calls.every(
          (c) =>
            (requestedModel
              ? c.arguments.model ===
                (scenario === 8 && c.arguments.resume ? alternateModel : childModel)
              : true) &&
            (named
              ? c.arguments.agent === "summarizer" ||
                (scenario === 9 &&
                  c.arguments.resume !== undefined &&
                  c.arguments.agent === undefined)
              : c.arguments.agent === undefined) &&
            (!named || c.arguments.prompt === undefined),
        ),
    continued: [4, 8, 9].includes(scenario)
      ? scored.calls.some((c) => typeof c.arguments.resume === "string" && c.accepted === true)
      : null,
    resumedAsSummarizer:
      scenario === 9
        ? scored.calls.some(
            (c) => c.arguments.resume !== undefined && c.identities.includes("summarizer"),
          )
        : null,
    defaultCalls: scored.calls.filter(
      (c) => c.arguments.agent === undefined && c.arguments.prompt === undefined,
    ).length,
    implicitResumeCalls: scored.calls.filter(
      (c) =>
        c.arguments.resume !== undefined &&
        c.arguments.agent === undefined &&
        c.arguments.prompt === undefined,
    ).length,
    fanoutCalls: scenario === 6 ? scored.calls.length : null,
  };
}
function isRun(value: unknown): value is Run {
  const r = object(value);
  return (
    typeof r.model === "string" &&
    typeof r.scenario === "number" &&
    typeof r.repetition === "number" &&
    Array.isArray(r.calls)
  );
}
const runs: Run[] = Array.isArray(saved.runs) ? saved.runs.filter(isRun) : [];
if (Array.isArray(saved.runs) && saved.runs.length !== runs.length)
  throw new Error("Invalid saved run");
const metadata = {
  extension,
  childModel,
  alternateModel,
  root,
  available,
  scenarios,
  selected,
  repetitions,
  modelSelection: options.get("models"),
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
          const failed = runs.find((r) => r.model === job.model && r.reason !== null);
          const result = failed
            ? {
                ...failed,
                ...job,
                dir: "",
                calls: [],
                parentErrors: [],
                reason: `not attempted after unavailable run: ${failed.reason}`,
                defaultCalls: 0,
                implicitResumeCalls: 0,
              }
            : await run(job.model, job.scenario, job.repetition);
          runs.push(result);
          await save();
          console.error(
            `${result.model} S${result.scenario} #${result.repetition}: ${result.reason ?? `first=${result.firstAccepted} all=${result.allAccepted}`}`,
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
    first: `${scored.filter((r) => r.firstAccepted).length}/${scored.length}`,
    all: `${scored.filter((r) => r.allAccepted).length}/${scored.length}`,
    fields: `${scored.filter((r) => r.fieldsCorrect).length}/${scored.length}`,
    unscored: group.length - scored.length,
    reasons: JSON.stringify(reasons),
  };
}
console.table([
  ...models.flatMap((model) =>
    selected.map((s) =>
      row(
        `${model} S${s}`,
        runs.filter((r) => r.model === model && r.scenario === s),
      ),
    ),
  ),
  row("TOTAL", runs),
]);
const rejections: Record<string, number> = {};
await save();
for (const result of runs)
  for (const call of result.calls)
    if (call.accepted === false && call.error)
      rejections[call.error] = (rejections[call.error] ?? 0) + 1;
console.log(JSON.stringify({ output, rejections }, null, 2));
