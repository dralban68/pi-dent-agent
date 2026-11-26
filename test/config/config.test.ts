import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SUPPORTED_ROOT_KEYS, attributeKey, readConfig } from "../../lib/config.ts";
import { readBootSnapshot } from "../../lib/engine.ts";
import { at } from "../support/must.ts";

function withIsolatedEnv<T>(fn: (ctx: { home: string; project: string }) => T): T {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-test-home-"));
  const project = mkdtempSync(join(tmpdir(), "pi-dent-test-project-"));
  const origHome = process.env.HOME;
  const origIdle = process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS;
  const origAbs = process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS;

  process.env.HOME = home;
  delete process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS;
  delete process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS;

  try {
    return fn({ home, project });
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;

    if (origIdle === undefined) delete process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS;
    else process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS = origIdle;

    if (origAbs === undefined) delete process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS;
    else process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS = origAbs;

    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

function writeConf(root: string, content: string): string {
  const dir = join(root, ".pi", "pi-dent");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "pi-dent.conf");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

/** The boot diagnostics about model classes, which carry the owning layer's file (Section 4). */
function modelClassMessages(project: string): string[] {
  return readBootSnapshot(project)
    .diagnostics.map((diagnostic) => diagnostic.message)
    .filter((message) => message.includes("modelClasses"));
}

test("project agentLiveness: { idleTimeoutMs: 'x' } + global agentLiveness: { idleTimeoutMs: 5 } → idleTimeoutMs 0 and a warning naming the project file", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(home, JSON.stringify({ agentLiveness: { idleTimeoutMs: 5 } }));
    const projectFile = writeConf(
      project,
      JSON.stringify({ agentLiveness: { idleTimeoutMs: "x" } }),
    );

    const config = readConfig(project);
    assert.equal(config.liveness.idleTimeoutMs, 0);
    assert.equal(config.liveness.absoluteTimeoutMs, 0);
    assert.equal(config.diagnostics.length, 1);
    assert.equal(
      at(config.diagnostics, 0).message,
      `config: ${projectFile}: agentLiveness.idleTimeoutMs must be an integer from 0 to 2147483647; ignored`,
    );
  });
});

test("project agentLiveness: { idleTimeoutMs: 7 } + global { idleTimeoutMs: 5, absoluteTimeoutMs: 9 } → 7 and 9", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(home, JSON.stringify({ agentLiveness: { idleTimeoutMs: 5, absoluteTimeoutMs: 9 } }));
    writeConf(project, JSON.stringify({ agentLiveness: { idleTimeoutMs: 7 } }));

    const config = readConfig(project);
    assert.equal(config.liveness.idleTimeoutMs, 7);
    assert.equal(config.liveness.absoluteTimeoutMs, 9);
    assert.equal(config.diagnostics.length, 0);
  });
});

test("project plugins: 'x' + global plugins: {a:{path:'/p'}} → merged.plugins === 'x'", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(home, JSON.stringify({ plugins: { a: { path: "/p" } } }));
    writeConf(project, JSON.stringify({ plugins: "x" }));

    const config = readConfig(project);
    assert.equal(config.merged.plugins, "x");
  });
});

test("a malformed model class is reported against the layer file that declares it", () => {
  withIsolatedEnv(({ home, project }) => {
    const globalFile = writeConf(home, JSON.stringify({ modelClasses: { fast: 123 } }));
    const projectFile = writeConf(project, JSON.stringify({ modelClasses: { quality: 456 } }));

    const messages = modelClassMessages(project);
    assert.equal(messages.length, 2, messages.join("\n"));
    assert.ok(
      messages.some((m) => m.includes("modelClasses.fast") && m.includes(globalFile)),
      `class fast is attributed to ${globalFile}: ${messages.join("\n")}`,
    );
    assert.ok(
      messages.some((m) => m.includes("modelClasses.quality") && m.includes(projectFile)),
      `class quality is attributed to ${projectFile}: ${messages.join("\n")}`,
    );
  });
});

test("a class key that Object.prototype also carries is attributed to the declaring file", () => {
  withIsolatedEnv(({ home, project }) => {
    const globalFile = writeConf(home, JSON.stringify({ modelClasses: { constructor: 123 } }));
    const projectFile = writeConf(project, JSON.stringify({ modelClasses: {} }));

    const messages = modelClassMessages(project);
    assert.equal(messages.length, 1, messages.join("\n"));
    const message = at(messages, 0);
    assert.ok(message.includes("modelClasses.constructor"), message);
    assert.ok(message.includes(globalFile), `attributed to ${globalFile}: ${message}`);
    assert.equal(
      message.includes(projectFile),
      false,
      `not attributed to ${projectFile}: ${message}`,
    );
  });
});

test("a modelClasses value that is not an object is one diagnostic naming its file", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(home, JSON.stringify({ modelClasses: { fast: "anthropic/claude-3-5-haiku" } }));
    const projectFile = writeConf(project, JSON.stringify({ modelClasses: "not-an-object" }));

    const messages = modelClassMessages(project);
    assert.equal(messages.length, 1, messages.join("\n"));
    const message = at(messages, 0);
    assert.ok(message.includes(projectFile), `names ${projectFile}: ${message}`);
  });
});

test("agentLiveness with unknown keys: exactly one diagnostic naming all of them; the known fields load", () => {
  withIsolatedEnv(({ project }) => {
    const projectFile = writeConf(
      project,
      JSON.stringify({ agentLiveness: { idleTimeoutMs: 7, bogusKey: 1, otherKey: 2 } }),
    );

    const config = readConfig(project);
    assert.equal(config.liveness.idleTimeoutMs, 7);
    assert.equal(config.liveness.absoluteTimeoutMs, 0);
    assert.deepEqual(
      config.diagnostics.map((d) => d.message),
      [`config: ${projectFile}: agentLiveness: unknown keys bogusKey, otherKey ignored`],
    );
  });
});

test("agentLiveness unknown keys declared by different layers each name their own file", () => {
  withIsolatedEnv(({ home, project }) => {
    const globalFile = writeConf(home, JSON.stringify({ agentLiveness: { bogusGlobal: 1 } }));
    const projectFile = writeConf(
      project,
      JSON.stringify({ agentLiveness: { idleTimeoutMs: 7, bogusProject: 2 } }),
    );

    const config = readConfig(project);
    assert.equal(config.liveness.idleTimeoutMs, 7);
    assert.deepEqual(
      config.diagnostics.map((d) => d.message),
      [
        `config: agentLiveness: unknown keys bogusGlobal (${globalFile}), bogusProject (${projectFile}) ignored`,
      ],
    );
  });
});

test("PI_DENT_AGENT_*_TIMEOUT_MS: only decimal digits are accepted; anything else is one diagnostic and falls through", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(home, JSON.stringify({ agentLiveness: { idleTimeoutMs: 5 } }));
    for (const bad of [" ", "1e3", "-1", "1.5", "0x10", " 7"]) {
      process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS = bad;
      const config = readConfig(project);
      assert.equal(config.liveness.idleTimeoutMs, 5, JSON.stringify(bad));
      assert.deepEqual(
        config.diagnostics.map((d) => d.message),
        ["config: PI_DENT_AGENT_IDLE_TIMEOUT_MS must be an integer from 0 to 2147483647; ignored"],
        JSON.stringify(bad),
      );
    }
    process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS = "9";
    const accepted = readConfig(project);
    assert.equal(accepted.liveness.idleTimeoutMs, 9);
    assert.deepEqual(accepted.diagnostics, []);
    process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS = "";
    assert.equal(readConfig(project).liveness.idleTimeoutMs, 5);
    assert.deepEqual(readConfig(project).diagnostics, []);
  });
});

test("substitution diagnostics name the value's key path and its layer's file; the value is absent and merge falls through", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(home, JSON.stringify({ plugins: { a: { path: "/global-plugin" } } }));
    const projectFile = writeConf(
      project,
      JSON.stringify({
        plugins: { a: { path: "${env.PI_DENT_TEST_MISSING_VAR}" } },
        agents: { list: ["keep", "${env.1BAD}"] },
        modelGuidance: { billing: "${nope}" },
        modelClasses: { fast: "${env.HOME" },
      }),
    );

    const config = readConfig(project);
    assert.deepEqual(
      config.diagnostics.map((d) => d.message),
      [
        `config: plugins.a.path: \`\${env.PI_DENT_TEST_MISSING_VAR}\` references undefined environment variable PI_DENT_TEST_MISSING_VAR (${projectFile})`,
        `config: agents.list[1]: invalid reference \`\${env.1BAD}\` (invalid environment variable name) (${projectFile})`,
        `config: modelGuidance.billing: invalid reference \`\${nope}\` (expected \${env.NAME} or \${project.root}) (${projectFile})`,
        `config: modelClasses.fast: invalid reference \`\${env.HOME\` (unterminated \${) (${projectFile})`,
      ],
    );
    assert.deepEqual(config.merged.plugins, { a: { path: "/global-plugin" } });
    assert.deepEqual(config.merged.agents, { list: ["keep"] });
    assert.deepEqual(config.merged.modelGuidance, {});
    assert.deepEqual(config.merged.modelClasses, {});
  });
});

test("unknown root keys: exactly one diagnostic naming the file, all keys, and the supported set", () => {
  withIsolatedEnv(({ project }) => {
    const projectFile = writeConf(
      project,
      JSON.stringify({ modelClasses: { fast: "anthropic/x" }, bogus: 1, another: true }),
    );

    const config = readConfig(project);
    assert.equal(config.diagnostics.length, 1, "one diagnostic for the layer root object");
    const message = at(config.diagnostics, 0).message;
    assert.ok(message.includes(projectFile), `file named: ${message}`);
    assert.match(message, /unknown root keys "bogus", "another"/);
    for (const key of SUPPORTED_ROOT_KEYS) {
      assert.ok(message.includes(`"${key}"`), `supported key ${key} named in ${message}`);
    }
    assert.deepEqual(config.merged, { modelClasses: { fast: "anthropic/x" } });
  });
});

for (const key of ["terms", "web", "webSearch"] as const) {
  test(`${key} is a known root key: pi-dent reports nothing about its value or subkeys and merges it deeply`, () => {
    assert.ok(SUPPORTED_ROOT_KEYS.includes(key));
    withIsolatedEnv(({ home, project }) => {
      const globalFile = writeConf(home, JSON.stringify({ [key]: { checkAfterEdit: true } }));
      const projectFile = writeConf(
        project,
        JSON.stringify({ [key]: { bogusSubkey: 1, root: "${project.root}" } }),
      );
      const config = readConfig(project);
      assert.deepEqual(config.diagnostics, []);
      assert.deepEqual(config.merged[key], {
        checkAfterEdit: true,
        bogusSubkey: 1,
        root: project,
      });
      assert.equal(attributeKey(config, [key, "checkAfterEdit"]), globalFile);
      assert.equal(attributeKey(config, [key, "bogusSubkey"]), projectFile);
    });
    withIsolatedEnv(({ project }) => {
      writeConf(project, JSON.stringify({ [key]: "not-an-object" }));
      const config = readConfig(project);
      assert.deepEqual(config.diagnostics, []);
      assert.equal(config.merged[key], "not-an-object");
    });
  });
}

test("a layer whose parse fails is dropped with one diagnostic and the other layer still provides its values", () => {
  withIsolatedEnv(({ home, project }) => {
    const globalFile = writeConf(
      home,
      JSON.stringify({ modelClasses: { fast: "anthropic/x" }, plugins: { a: { path: "/g" } } }),
    );
    const projectFile = writeConf(project, '{ "plugins": { "a": ');
    const config = readConfig(project);
    assert.equal(config.diagnostics.length, 1, JSON.stringify(config.diagnostics));
    const message = at(config.diagnostics, 0).message;
    assert.ok(message.includes(projectFile), `names the dropped layer's file: ${message}`);
    assert.match(message, /failed to parse/);
    assert.equal(
      message.includes(globalFile),
      false,
      `not attributed to ${globalFile}: ${message}`,
    );
    assert.deepEqual(config.merged.modelClasses, { fast: "anthropic/x" });
    assert.deepEqual(config.merged.plugins, { a: { path: "/g" } });
    assert.equal(config.layers.project, undefined, "the malformed layer contributes nothing");
    assert.equal(config.layers.global?.path, globalFile);
  });
});

test("a layer whose root is not an object is dropped with one diagnostic and the other layer still provides its values", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(home, JSON.stringify({ modelClasses: { fast: "anthropic/x" } }));
    const projectFile = writeConf(project, '["not", "an", "object"]');
    const config = readConfig(project);
    assert.equal(config.diagnostics.length, 1, JSON.stringify(config.diagnostics));
    assert.equal(
      at(config.diagnostics, 0).message,
      `config: ${projectFile}: root must be an object; layer dropped`,
    );
    assert.deepEqual(config.merged, { modelClasses: { fast: "anthropic/x" } });
  });
});

test("a layer whose file cannot be read is dropped with one diagnostic and the other layer still provides its values", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("the root user reads through file modes, so the unreadable case cannot be produced");
    return;
  }
  withIsolatedEnv(({ home, project }) => {
    writeConf(home, JSON.stringify({ modelClasses: { fast: "anthropic/x" } }));
    const projectFile = writeConf(
      project,
      JSON.stringify({ modelClasses: { slow: "anthropic/y" } }),
    );
    chmodSync(projectFile, 0o000);
    const config = readConfig(project);
    assert.equal(config.diagnostics.length, 1, JSON.stringify(config.diagnostics));
    const message = at(config.diagnostics, 0).message;
    assert.ok(message.includes(projectFile), `names the unreadable file: ${message}`);
    assert.match(message, /failed to read/);
    assert.deepEqual(config.merged, { modelClasses: { fast: "anthropic/x" } });
  });
});

test("$$ renders a literal $ and a lone $ stays literal (config-file.md Section 7)", () => {
  withIsolatedEnv(({ project }) => {
    const projectFile = writeConf(
      project,
      JSON.stringify({
        plugins: { a: { path: "$${env.HOME}" } },
        agents: { list: ["a $ b", "$$5"] },
      }),
    );
    const config = readConfig(project);
    assert.deepEqual(config.diagnostics, [], JSON.stringify(config.diagnostics));
    assert.deepEqual(config.merged.plugins, { a: { path: "${env.HOME}" } });
    assert.deepEqual(config.merged.agents, { list: ["a $ b", "$5"] });
    assert.equal(attributeKey(config, ["plugins", "a", "path"]), projectFile);
  });
});

test("an unterminated block comment is a parse failure of its layer, never silently accepted", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(home, JSON.stringify({ modelClasses: { fast: "anthropic/x" } }));
    // Dropping the unterminated comment up to end-of-file left a valid document, so the
    // layer loaded with the malformed comment unreported (config-file.md Section 2).
    const projectFile = writeConf(
      project,
      '{ "modelClasses": { "slow": "anthropic/y" } } /* never closed\n',
    );
    const config = readConfig(project);
    assert.equal(config.diagnostics.length, 1, JSON.stringify(config.diagnostics));
    const message = at(config.diagnostics, 0).message;
    assert.ok(message.includes(projectFile), `names the failing layer's file: ${message}`);
    assert.match(message, /failed to parse/);
    assert.match(message, /unterminated block comment/);
    assert.deepEqual(config.merged, { modelClasses: { fast: "anthropic/x" } });
  });
});

test("a comma with no value before it is a parse failure of its layer", () => {
  for (const body of ["{,}", "[,]"]) {
    withIsolatedEnv(({ home, project }) => {
      writeConf(home, JSON.stringify({ modelClasses: { fast: "anthropic/x" } }));
      // Dropping every comma before a closing bracket accepted `{,}` and `[,]`, which
      // are not JSONC (config-file.md Section 2).
      const projectFile = writeConf(project, `{ "modelClasses": ${body} }`);
      const config = readConfig(project);
      assert.equal(config.diagnostics.length, 1, JSON.stringify(config.diagnostics));
      const message = at(config.diagnostics, 0).message;
      assert.ok(message.includes(projectFile), `names the failing layer's file: ${message}`);
      assert.match(message, /failed to parse/);
      assert.deepEqual(config.merged, { modelClasses: { fast: "anthropic/x" } });
    });
  }
});

test("PI_DENT_AGENT_IDLE_TIMEOUT_MS above 2147483647 is one diagnostic and the config value applies", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(home, JSON.stringify({ agentLiveness: { idleTimeoutMs: 5 } }));
    process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS = "2147483648";

    const config = readConfig(project);
    assert.equal(config.liveness.idleTimeoutMs, 5);
    assert.deepEqual(
      config.diagnostics.map((d) => d.message),
      ["config: PI_DENT_AGENT_IDLE_TIMEOUT_MS must be an integer from 0 to 2147483647; ignored"],
    );
  });
});

test("agentLiveness.idleTimeoutMs above 2147483647 is one diagnostic and 0 applies", () => {
  withIsolatedEnv(({ project }) => {
    const projectFile = writeConf(
      project,
      JSON.stringify({ agentLiveness: { idleTimeoutMs: 2147483648 } }),
    );

    const config = readConfig(project);
    assert.equal(config.liveness.idleTimeoutMs, 0);
    assert.deepEqual(
      config.diagnostics.map((d) => d.message),
      [
        `config: ${projectFile}: agentLiveness.idleTimeoutMs must be an integer from 0 to 2147483647; ignored`,
      ],
    );
  });
});

test("2147483647 is the largest accepted deadline, from the environment and the configuration", () => {
  withIsolatedEnv(({ project }) => {
    writeConf(project, JSON.stringify({ agentLiveness: { absoluteTimeoutMs: 2147483647 } }));
    process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS = "2147483647";

    const config = readConfig(project);
    assert.equal(config.liveness.idleTimeoutMs, 2147483647);
    assert.equal(config.liveness.absoluteTimeoutMs, 2147483647);
    assert.deepEqual(config.diagnostics, []);
  });
});
