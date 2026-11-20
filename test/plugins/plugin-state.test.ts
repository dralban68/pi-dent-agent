import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deletePluginState,
  ensurePluginStateDataDir,
  getPluginState,
  listPluginStateKeys,
  PLUGIN_STATE_KEY_MAX_LENGTH,
  PLUGIN_STATE_SCOPE_CAP_BYTES,
  PLUGIN_STATE_VALUE_CAP_BYTES,
  PLUGIN_STATE_VERSION,
  PluginStateError,
  pluginStatePaths,
  readPluginStateEntry,
  setPluginState,
  watchPluginState,
  type PluginStateTarget,
} from "../../lib/plugin-state.ts";
import { PLUGIN_UI_WIDGET_KEY, PluginUiController } from "../../lib/plugin-ui.ts";
import type { PluginEntry } from "../../lib/plugins.ts";
import { runScript } from "../../lib/script-runner.ts";

function makeTempWorkspace(): { dir: string; userRoot: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-dent-plugin-state-")));
  const userRoot = join(dir, "user-home-pi-dent");
  return {
    dir,
    userRoot,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("lazy creation, .gitignore hygiene, CRUD, and UTF-16 key ordering", async () => {
  const fx = makeTempWorkspace();
  try {
    const ws: PluginStateTarget = { namespace: "demo", scope: "workspace", workspaceRoot: fx.dir };
    const paths = pluginStatePaths(ws);

    // Reads, keys, delete on missing .pi/ create nothing; defaultValue returned by identity.
    const sentinel = { marker: true };
    assert.equal(await getPluginState(ws, "missing"), undefined);
    assert.strictEqual(await getPluginState(ws, "missing", sentinel), sentinel);
    assert.deepEqual(await readPluginStateEntry(ws, "missing"), { found: false });
    assert.deepEqual(await listPluginStateKeys(ws), []);
    await deletePluginState(ws, "missing");
    assert.equal(existsSync(join(fx.dir, ".pi")), false);

    // First write creates state.json and .pi/pi-dent/state/.gitignore.
    await setPluginState(ws, "b", { n: 2 });
    await setPluginState(ws, "a", [1, true, null, "x"]);
    await setPluginState(ws, "Z", 0);

    assert.equal(existsSync(paths.storeFile), true);
    assert.equal(paths.gitignoreFile !== undefined && existsSync(paths.gitignoreFile), true);
    assert.equal(readFileSync(paths.gitignoreFile as string, "utf8"), "*\n");

    const disk = JSON.parse(readFileSync(paths.storeFile, "utf8")) as {
      version: number;
      entries: Record<string, unknown>;
    };
    assert.equal(disk.version, PLUGIN_STATE_VERSION);
    assert.deepEqual(disk.entries.b, { n: 2 });

    // Existing .gitignore is never overwritten.
    writeFileSync(paths.gitignoreFile as string, "custom\n", "utf8");
    await setPluginState(ws, "c", "ok");
    assert.equal(readFileSync(paths.gitignoreFile as string, "utf8"), "custom\n");

    // Keys sorted in ascending UTF-16 code-unit order ("Z" < "a" < "b" < "c").
    assert.deepEqual(await listPluginStateKeys(ws), ["Z", "a", "b", "c"]);
    assert.deepEqual(await getPluginState(ws, "a"), [1, true, null, "x"]);
    assert.deepEqual(await readPluginStateEntry(ws, "a"), {
      found: true,
      value: [1, true, null, "x"],
    });

    await deletePluginState(ws, "b");
    assert.equal(await getPluginState(ws, "b", "gone"), "gone");
    assert.deepEqual(await listPluginStateKeys(ws), ["Z", "a", "c"]);

    // Data dir created lazily.
    assert.equal(existsSync(paths.dataDir), false);
    const dataDir = ensurePluginStateDataDir(ws);
    assert.equal(dataDir, paths.dataDir);
    assert.equal(existsSync(dataDir), true);

    // User scope is separate and has no .gitignore.
    const user: PluginStateTarget = {
      namespace: "demo",
      scope: "user",
      userStateRoot: fx.userRoot,
    };
    const userPaths = pluginStatePaths(user);
    assert.equal(userPaths.gitignoreFile, undefined);
    await setPluginState(user, "pref", "dark");
    assert.equal(await getPluginState(user, "pref"), "dark");
    assert.equal(await getPluginState(ws, "pref"), undefined);
    const userDataDir = ensurePluginStateDataDir(user);
    assert.equal(existsSync(userDataDir), true);
  } finally {
    fx.cleanup();
  }
});

test("enforces validation rules, stable PluginStateError codes, and exact error texts", async () => {
  const fx = makeTempWorkspace();
  try {
    const expectCode = (code: string, message: string) => (err: unknown) =>
      err instanceof PluginStateError && err.code === code && err.message === message;

    assert.throws(
      () => pluginStatePaths({ namespace: "../bad", scope: "workspace", workspaceRoot: fx.dir }),
      expectCode("INVALID_NAMESPACE", 'Invalid plugin namespace: "../bad"'),
    );
    assert.throws(
      () =>
        pluginStatePaths({
          namespace: "demo",
          scope: "other" as "workspace",
          workspaceRoot: fx.dir,
        }),
      expectCode("INVALID_SCOPE", 'Invalid plugin state scope: "other"'),
    );
    assert.throws(
      () => pluginStatePaths({ namespace: "demo", scope: "workspace", workspaceRoot: "relative" }),
      expectCode("INVALID_WORKSPACE_ROOT", "Workspace root must be an absolute path"),
    );

    const ws: PluginStateTarget = { namespace: "demo", scope: "workspace", workspaceRoot: fx.dir };
    await assert.rejects(
      () => setPluginState(ws, "", 1),
      expectCode("INVALID_KEY", "State key must be a non-empty string"),
    );
    await assert.rejects(
      () => setPluginState(ws, "k".repeat(PLUGIN_STATE_KEY_MAX_LENGTH + 1), 1),
      expectCode("INVALID_KEY", `State key exceeds ${PLUGIN_STATE_KEY_MAX_LENGTH} characters`),
    );
    await assert.rejects(
      () => setPluginState(ws, "a\0b", 1),
      expectCode("INVALID_KEY", "State key must not contain null characters"),
    );
    await assert.rejects(
      () => setPluginState(ws, "k", undefined),
      expectCode("INVALID_VALUE", "State value must be a JSON value"),
    );
    await assert.rejects(
      () => setPluginState(ws, "k", Number.NaN),
      expectCode("INVALID_VALUE", "State value must be a JSON value"),
    );
    await assert.rejects(
      () => setPluginState(ws, "k", "x".repeat(PLUGIN_STATE_VALUE_CAP_BYTES - 1)),
      expectCode("VALUE_TOO_LARGE", `State value exceeds ${PLUGIN_STATE_VALUE_CAP_BYTES} bytes`),
    );

    // Scope total size cap (5 MiB): write 20 keys of ~260 KiB each, then 21st exceeds 5,242,880 bytes.
    const chunk = "a".repeat(260_000);
    for (let i = 0; i < 20; i++) {
      await setPluginState(ws, `k${i}`, chunk);
    }
    await assert.rejects(
      () => setPluginState(ws, "overflow", chunk),
      expectCode("STORE_TOO_LARGE", `State store exceeds ${PLUGIN_STATE_SCOPE_CAP_BYTES} bytes`),
    );
  } finally {
    fx.cleanup();
  }
});

test("reports corrupt and unreadable store files with scope/namespace (no absolute paths) without resetting them", async () => {
  const fx = makeTempWorkspace();
  try {
    const ws: PluginStateTarget = { namespace: "demo", scope: "workspace", workspaceRoot: fx.dir };
    const paths = pluginStatePaths(ws);
    mkdirSync(paths.storeDir, { recursive: true });
    writeFileSync(paths.storeFile, "{not valid json", "utf8");

    const isCorruptWithoutPath = (err: unknown): boolean =>
      err instanceof PluginStateError &&
      err.code === "STORE_CORRUPT" &&
      err.message.startsWith("Plugin state store is corrupt (workspace/demo):") &&
      !err.message.includes(fx.dir);

    await assert.rejects(() => getPluginState(ws, "a"), isCorruptWithoutPath);
    await assert.rejects(() => listPluginStateKeys(ws), isCorruptWithoutPath);
    await assert.rejects(() => setPluginState(ws, "a", 1), isCorruptWithoutPath);
    await assert.rejects(() => deletePluginState(ws, "a"), isCorruptWithoutPath);
    // File was NOT reset.
    assert.equal(readFileSync(paths.storeFile, "utf8"), "{not valid json");

    // Wrong version also rejected as corrupt.
    writeFileSync(paths.storeFile, JSON.stringify({ version: 2, entries: {} }), "utf8");
    await assert.rejects(() => getPluginState(ws, "a"), isCorruptWithoutPath);

    // Unreadable store file (directory at state.json path -> EISDIR) reports STORE_UNREADABLE without path.
    const dirTarget: PluginStateTarget = {
      namespace: "dir-store",
      scope: "workspace",
      workspaceRoot: fx.dir,
    };
    const dirPaths = pluginStatePaths(dirTarget);
    mkdirSync(dirPaths.storeFile, { recursive: true });
    await assert.rejects(
      () => getPluginState(dirTarget, "a"),
      (err: unknown) =>
        err instanceof PluginStateError &&
        err.code === "STORE_UNREADABLE" &&
        err.message.startsWith("Plugin state store unreadable (workspace/dir-store):") &&
        !err.message.includes(fx.dir),
    );

    // Read-only workspace rejects writes (skip if running as root).
    if (process.getuid?.() !== 0) {
      const roDir = join(fx.dir, "readonly-ws");
      mkdirSync(roDir, { recursive: true });
      chmodSync(roDir, 0o555);
      try {
        const roTarget: PluginStateTarget = {
          namespace: "demo",
          scope: "workspace",
          workspaceRoot: roDir,
        };
        assert.equal(await getPluginState(roTarget, "a", "def"), "def");
        await assert.rejects(() => setPluginState(roTarget, "a", 1), /EACCES|EPERM|EROFS/);
      } finally {
        chmodSync(roDir, 0o755);
      }
    }
  } finally {
    fx.cleanup();
  }
});

test("watchPluginState start semantics: sync target/listener checks, no initial key replay, corrupt-at-start to onError", async () => {
  const fx = makeTempWorkspace();
  try {
    // Invalid target and non-function listener throw synchronously (never routed to onError).
    let onErrorCalled = false;
    assert.throws(
      () =>
        watchPluginState(
          { namespace: "../bad", scope: "workspace", workspaceRoot: fx.dir },
          () => {},
          () => {
            onErrorCalled = true;
          },
        ),
      (err: unknown) => err instanceof PluginStateError && err.code === "INVALID_NAMESPACE",
    );
    assert.throws(
      () =>
        watchPluginState(
          { namespace: "demo", scope: "workspace", workspaceRoot: fx.dir },
          "bad" as unknown as () => void,
          () => {
            onErrorCalled = true;
          },
        ),
      { name: "TypeError", message: "onChange listener must be a function" },
    );
    assert.equal(onErrorCalled, false);

    // Existing keys at watch start are NOT emitted; subsequent writes ARE emitted.
    const ws: PluginStateTarget = { namespace: "pre", scope: "workspace", workspaceRoot: fx.dir };
    await setPluginState(ws, "already", 1);
    const seen: Array<{ key: string; value: unknown }> = [];
    const w1 = watchPluginState(ws, (key, value) => seen.push({ key, value }));
    try {
      await setPluginState(ws, "later", 2);
      assert.deepEqual(seen, [{ key: "later", value: 2 }]);
    } finally {
      w1.close();
    }

    // Corrupt store at watch start reports STORE_CORRUPT to onError and recovers when repaired.
    const badWs: PluginStateTarget = {
      namespace: "corrupt-start",
      scope: "workspace",
      workspaceRoot: fx.dir,
    };
    const badPaths = pluginStatePaths(badWs);
    mkdirSync(badPaths.storeDir, { recursive: true });
    writeFileSync(badPaths.storeFile, "{broken", "utf8");
    const errs: Error[] = [];
    const recovered: Array<{ key: string; value: unknown }> = [];
    const w2 = watchPluginState(
      badWs,
      (key, value) => recovered.push({ key, value }),
      (err) => errs.push(err),
    );
    try {
      const deadline = Date.now() + 2000;
      while (errs.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(errs[0] instanceof PluginStateError);
      assert.equal((errs[0] as PluginStateError).code, "STORE_CORRUPT");

      // Repair file -> watcher reports the entries now present.
      writeFileSync(
        badPaths.storeFile,
        JSON.stringify({ version: PLUGIN_STATE_VERSION, entries: { fixed: true } }),
        "utf8",
      );
      const fixDeadline = Date.now() + 2000;
      while (recovered.length === 0 && Date.now() < fixDeadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.deepEqual(recovered, [{ key: "fixed", value: true }]);
    } finally {
      w2.close();
    }
  } finally {
    fx.cleanup();
  }
});

test("watchPluginState reports own-process and cross-process changes in UTF-16 order without duplicates", async () => {
  const fx = makeTempWorkspace();
  try {
    const ws: PluginStateTarget = { namespace: "demo", scope: "workspace", workspaceRoot: fx.dir };
    const events: Array<{ key: string; value: unknown }> = [];
    const errors: Error[] = [];

    // Start watching BEFORE .pi/ exists.
    const watcher = watchPluginState(
      ws,
      (key, value) => {
        events.push({ key, value });
        if (key === "throw-me") throw new Error("listener boom");
      },
      (err) => errors.push(err),
    );

    try {
      await setPluginState(ws, "a", 1);
      // Equal value emits nothing.
      await setPluginState(ws, "a", 1);
      await setPluginState(ws, "throw-me", true);
      await setPluginState(ws, "b", "two");
      await deletePluginState(ws, "a");

      assert.deepEqual(events, [
        { key: "a", value: 1 },
        { key: "throw-me", value: true },
        { key: "b", value: "two" },
        { key: "a", value: undefined },
      ]);

      // Cross-process write from a script worker reaches watcher.
      const handle = runScript({
        code: `await dent.state.set("from-worker", { ok: true });`,
        filename: join(fx.dir, "scripts", "w.ts"),
        cwd: fx.dir,
        input: undefined,
        aliases: {},
        pluginNamespace: "demo",
        stateWorkspaceRoot: fx.dir,
      });
      const res = await handle.promise;
      assert.equal(res.exitReason, "ok");

      const deadline = Date.now() + 2000;
      while (!events.some((e) => e.key === "from-worker") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.deepEqual(
        events.find((e) => e.key === "from-worker"),
        { key: "from-worker", value: { ok: true } },
      );

      // Corrupt file reports to onError without resetting snapshot.
      const paths = pluginStatePaths(ws);
      writeFileSync(paths.storeFile, "{corrupt", "utf8");
      const errDeadline = Date.now() + 2000;
      while (errors.length === 0 && Date.now() < errDeadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(errors.length >= 1);
      assert.match(errors[0]?.message ?? "", /Plugin state store is corrupt/);
    } finally {
      watcher.close();
    }
  } finally {
    fx.cleanup();
  }
});

test("dent.state is bound for plugin scripts and UI calls, absent for inline scripts, and handles concurrent writes + onChange", async () => {
  const fx = makeTempWorkspace();
  try {
    // Inline script (no pluginNamespace): dent.state is undefined.
    const inlineHandle = runScript({
      code: "export default typeof dent.state;",
      filename: join(fx.dir, "__inline__.ts"),
      cwd: fx.dir,
      input: undefined,
      aliases: {},
    });
    const inlineRes = await inlineHandle.promise;
    assert.equal(inlineRes.exitReason, "ok");
    assert.equal(inlineRes.returnValue, "undefined");

    // Plugin UI call with workspace + user state, dir getter, and concurrent writes.
    const pluginRoot = join(fx.dir, "demo-plugin");
    mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
    writeFileSync(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "demo" }));
    writeFileSync(
      join(pluginRoot, "scripts", "state-test.ts"),
      `
      const seen: Array<{ key: string; value: unknown }> = [];
      const unsub = dent.state.onChange((key, value) => {
        seen.push({ key, value });
      });

      let badListenerErr = "";
      try {
        dent.state.onChange("not-a-fn" as unknown as () => void);
      } catch (err) {
        badListenerErr = err instanceof Error ? err.name + ": " + err.message : String(err);
      }

      await dent.state.set("from-ui", 42);
      await dent.state.user.set("user-key", "hello");
      const wsDir = dent.state.dir;
      const userDir = dent.state.user.dir;
      const keys = await dent.state.keys();
      const userVal = await dent.state.user.get("user-key");
      const defVal = await dent.state.get("absent", "default");
      unsub();

      export default { seen, badListenerErr, wsDir, userDir, keys, userVal, defVal };
      `,
      "utf8",
    );

    const pluginIndex = new Map<string, PluginEntry>([
      ["demo", { name: "demo", root: pluginRoot, commands: [] }],
    ]);
    const ctrl = new PluginUiController(pluginIndex);
    const replies = new Map<string, { ok: boolean; value?: unknown; error?: string | undefined }>();
    let resolveReply: (() => void) | undefined;
    const replyDone = new Promise<void>((resolve) => {
      resolveReply = resolve;
    });

    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r-state", namespace: "demo", root: pluginRoot, path: "scripts/state-test.ts", data: null })}`,
      {
        cwd: fx.dir,
        extraEnv: { PI_DENT_STATE_DIR: fx.userRoot },
        setWidget(key, lines) {
          if (key !== PLUGIN_UI_WIDGET_KEY || !lines?.[0]) return;
          const rec = JSON.parse(lines[0]) as {
            type: string;
            id: string;
            ok?: boolean;
            value?: unknown;
            error?: string;
          };
          if (rec.type === "reply") {
            replies.set(rec.id, { ok: Boolean(rec.ok), value: rec.value, error: rec.error });
            resolveReply?.();
          }
        },
      },
    );

    // Concurrent write on a different key from the host process while the UI script runs.
    const wsTarget: PluginStateTarget = {
      namespace: "demo",
      scope: "workspace",
      workspaceRoot: fx.dir,
    };
    await setPluginState(wsTarget, "from-host", "concurrent");

    await replyDone;
    const reply = replies.get("r-state");
    assert.ok(reply?.ok, `expected ok reply, got: ${JSON.stringify(reply)}`);
    const val = reply.value as {
      seen: Array<{ key: string; value: unknown }>;
      badListenerErr: string;
      wsDir: string;
      userDir: string;
      keys: string[];
      userVal: string;
      defVal: string;
    };
    assert.equal(val.badListenerErr, "TypeError: onChange listener must be a function");
    assert.equal(val.userVal, "hello");
    assert.equal(val.defVal, "default");
    assert.equal(existsSync(val.wsDir), true);
    assert.equal(existsSync(val.userDir), true);
    assert.ok(val.seen.some((e) => e.key === "from-ui" && e.value === 42));

    // Both concurrent writes survived (no lost update).
    assert.equal(await getPluginState(wsTarget, "from-ui"), 42);
    assert.equal(await getPluginState(wsTarget, "from-host"), "concurrent");
  } finally {
    fx.cleanup();
  }
});
