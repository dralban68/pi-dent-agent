import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBootSnapshot, type BootSnapshot } from "../../lib/engine.ts";

/**
 * Environment values per specs/agent-tool.md#recovery and specs/agent-tool.md#retention-sweep and
 * specs/config-file.md#diagnostics: decimal digits only, one diagnostic and the
 * default for any other value; unset or empty is silent.
 */

const NAMES = ["PI_DENT_AGENT_RECOVERY_MAX_RETRIES", "PI_DENT_SESSION_TTL_DAYS"] as const;

/** Boot the snapshot under an isolated HOME and project with the given environment values. */
function bootWithEnv(values: Partial<Record<(typeof NAMES)[number], string>>): BootSnapshot {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-env-home-"));
  const project = mkdtempSync(join(tmpdir(), "pi-dent-env-project-"));
  const saved = new Map(NAMES.map((name) => [name, process.env[name]]));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  for (const name of NAMES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return readBootSnapshot(project);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

function messagesMentioning(boot: BootSnapshot, name: string): string[] {
  return boot.diagnostics.filter((d) => d.message.includes(name)).map((d) => d.message);
}

test("PI_DENT_AGENT_RECOVERY_MAX_RETRIES: decimal digits are accepted", () => {
  const boot = bootWithEnv({ PI_DENT_AGENT_RECOVERY_MAX_RETRIES: "5" });
  assert.equal(boot.maxRecoveryRetries, 5);
  assert.deepEqual(messagesMentioning(boot, "PI_DENT_AGENT_RECOVERY_MAX_RETRIES"), []);
});

test("PI_DENT_AGENT_RECOVERY_MAX_RETRIES: any other value is one diagnostic and the default 2", () => {
  for (const bad of [" ", "1e3", "-1", "2.5", "0x3"]) {
    const boot = bootWithEnv({ PI_DENT_AGENT_RECOVERY_MAX_RETRIES: bad });
    assert.equal(boot.maxRecoveryRetries, 2, JSON.stringify(bad));
    assert.deepEqual(
      messagesMentioning(boot, "PI_DENT_AGENT_RECOVERY_MAX_RETRIES"),
      ["pi-dent: PI_DENT_AGENT_RECOVERY_MAX_RETRIES must be a non-negative integer; using 2"],
      JSON.stringify(bad),
    );
  }
});

test("PI_DENT_SESSION_TTL_DAYS: a positive decimal integer is accepted", () => {
  const boot = bootWithEnv({ PI_DENT_SESSION_TTL_DAYS: "7" });
  assert.equal(boot.sessionTtlDays, 7);
  assert.deepEqual(messagesMentioning(boot, "PI_DENT_SESSION_TTL_DAYS"), []);
});

test("PI_DENT_SESSION_TTL_DAYS: zero, negative, and non-digit values are one diagnostic and the default 30", () => {
  for (const bad of ["0", "-1", "1e3", " ", "3.5"]) {
    const boot = bootWithEnv({ PI_DENT_SESSION_TTL_DAYS: bad });
    assert.equal(boot.sessionTtlDays, 30, JSON.stringify(bad));
    assert.deepEqual(
      messagesMentioning(boot, "PI_DENT_SESSION_TTL_DAYS"),
      ["pi-dent: PI_DENT_SESSION_TTL_DAYS must be a positive integer; using 30"],
      JSON.stringify(bad),
    );
  }
});

test("unset or empty environment values are silent and take the defaults", () => {
  const empty = bootWithEnv({
    PI_DENT_AGENT_RECOVERY_MAX_RETRIES: "",
    PI_DENT_SESSION_TTL_DAYS: "",
  });
  assert.equal(empty.maxRecoveryRetries, 2);
  assert.equal(empty.sessionTtlDays, 30);
  assert.deepEqual(messagesMentioning(empty, "PI_DENT_AGENT_RECOVERY_MAX_RETRIES"), []);
  assert.deepEqual(messagesMentioning(empty, "PI_DENT_SESSION_TTL_DAYS"), []);

  const unset = bootWithEnv({});
  assert.equal(unset.maxRecoveryRetries, 2);
  assert.equal(unset.sessionTtlDays, 30);
});
