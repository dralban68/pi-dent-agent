/* eslint-disable no-console -- A CLI evaluation prints progress and results. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
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
const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agent-dispatch-"));
const output = resolve(options.get("output") ?? join(root, "results.json"));
const scenarios = [
  `Have a separate ad-hoc agent running on ${childModel} reply with the single word pong. Tell me its answer.`,
  "Have a separate ad-hoc agent reply with the single word pong. Tell me its answer.",
  "Use the summarizer agent to summarize 'The sky is blue' in one word. Tell me its answer.",
  "Have a separate ad-hoc agent remember the word violet and acknowledge in one word. Then send that same agent a follow-up asking which word it remembers. Tell me its answer.",
  `Use the summarizer agent running on ${childModel} to summarize 'The sky is blue' in one word. Tell me its answer.`,
];
const selected = (options.get("scenarios") ?? "1,2,3,4,5").split(",").map(Number);
if (selected.some((s) => !scenarios[s - 1])) throw new Error("Scenarios must be 1..5");
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
const listing = await command(["--list-models"], root);
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
            });
        }
    }
    if (message.role === "toolResult" && message.toolName === "Agent") {
      const call = calls.find((c) => c.id === message.toolCallId);
      if (!call) throw new Error("Unmatched Agent result");
      const error = text(message.content);
      const records = object(message.details).results;
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
      "-ne",
      "-e",
      extension,
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
  const requestedModel = scenario === 1 || scenario === 5;
  const named = scenario === 3 || scenario === 5;
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
            (requestedModel ? c.arguments.model === childModel : true) &&
            (named ? c.arguments.agent === "summarizer" : c.arguments.agent === undefined) &&
            (!named || c.arguments.prompt === undefined),
        ),
    continued:
      scenario === 4
        ? scored.calls.some((c) => typeof c.arguments.resume === "string" && c.accepted === true)
        : null,
  };
}
const runs: Run[] = [];
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
          const result = await run(job.model, job.scenario, job.repetition);
          runs.push(result);
          await writeFile(
            output,
            JSON.stringify({ extension, childModel, root, available, scenarios, runs }, null, 2),
          );
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
await writeFile(
  output,
  JSON.stringify({ extension, childModel, root, available, scenarios, runs }, null, 2),
);
for (const result of runs)
  for (const call of result.calls)
    if (call.accepted === false && call.error)
      rejections[call.error] = (rejections[call.error] ?? 0) + 1;
console.log(JSON.stringify({ output, rejections }, null, 2));
