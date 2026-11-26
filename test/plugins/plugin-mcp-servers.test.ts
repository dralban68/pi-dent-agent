import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "../../lib/config.ts";
import { readPluginInventory } from "../../lib/plugin-inventory.ts";
import {
  createPluginMcpRegistrar,
  MCP_RUNTIME_REGISTER_EVENT,
  type McpRuntimeRegistrationRequest,
} from "../../lib/plugin-mcp.ts";
import { discoverPlugins, type PluginEntry } from "../../lib/plugins.ts";
import type { Diagnostic } from "../../lib/util.ts";

/**
 * Plugin-declared HTTPS MCP servers per specs/plugin.md#plugin-manifest, specs/plugin.md#shape, and specs/plugin.md#mcp-servers.
 */

function writePlugin(root: string, dirName: string, manifest: Record<string, unknown>): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

function writeProjectConf(cwd: string, plugins: Record<string, { path: string }>): void {
  const confDir = join(cwd, ".pi", "pi-dent");
  mkdirSync(confDir, { recursive: true });
  writeFileSync(join(confDir, "pi-dent.conf"), JSON.stringify({ plugins }), "utf8");
}

function withIsolatedHome<T>(fn: (root: string, cwd: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-plugin-mcp-"));
  const home = join(root, "home");
  const cwd = join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(root, cwd);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
}

test("specs/plugin.md#plugin-manifest & 11.1: valid mcpServers are parsed in UTF-16 order and inventory exposes headerNames without values", () => {
  withIsolatedHome((root, cwd) => {
    const dir = writePlugin(root, "acme", {
      name: "acme",
      mcpServers: {
        zeta: {
          url: "https://zeta.example.com/mcp",
          headers: { "X-Z": "secret-z", Authorization: "Bearer top-secret" },
          auth: "oauth",
          description: "Zeta docs",
        },
        alpha: {
          url: "https://alpha.example.com/mcp",
          description: 42,
        },
      },
    });
    writeProjectConf(cwd, { acme: { path: dir } });

    const diagnostics: Diagnostic[] = [];
    const catalog = discoverPlugins(readConfig(cwd), diagnostics);
    assert.deepEqual(diagnostics, []);
    assert.equal(catalog.plugins.length, 1);
    assert.deepEqual(catalog.plugins[0]?.mcpServers, [
      {
        name: "alpha",
        url: "https://alpha.example.com/mcp",
      },
      {
        name: "zeta",
        url: "https://zeta.example.com/mcp",
        headers: { Authorization: "Bearer top-secret", "X-Z": "secret-z" },
        auth: "oauth",
        description: "Zeta docs",
      },
    ]);

    const inv = readPluginInventory(cwd);
    assert.equal(inv.candidates.length, 1);
    assert.deepEqual(inv.candidates[0]?.diagnostics, []);
    assert.deepEqual(inv.candidates[0]?.plugin?.mcpServers, [
      {
        name: "alpha",
        url: "https://alpha.example.com/mcp",
        headerNames: [],
        auth: null,
        description: null,
      },
      {
        name: "zeta",
        url: "https://zeta.example.com/mcp",
        headerNames: ["Authorization", "X-Z"],
        auth: "oauth",
        description: "Zeta docs",
      },
    ]);
    assert.equal(JSON.stringify(inv).includes("top-secret"), false);
    assert.equal(JSON.stringify(inv).includes("secret-z"), false);
  });
});

test("specs/plugin.md#plugin-manifest: non-object mcpServers is ignored with one warning diagnostic naming plugin.json", () => {
  withIsolatedHome((root, cwd) => {
    const dir = writePlugin(root, "bad-root", {
      name: "bad-root",
      mcpServers: ["https://example.com"],
    });
    writeProjectConf(cwd, { bad: { path: dir } });

    const inv = readPluginInventory(cwd);
    assert.deepEqual(inv.candidates[0]?.plugin?.mcpServers, []);
    assert.equal(inv.candidates[0]?.diagnostics.length, 1);
    assert.match(inv.candidates[0]?.diagnostics[0] ?? "", /plugin\.json.*mcpServers/);
  });
});

test("specs/plugin.md#plugin-manifest: invalid names, URLs, headers, auth, and unknown keys are validated with diagnostics", () => {
  withIsolatedHome((root, cwd) => {
    const dir = writePlugin(root, "mixed", {
      name: "mixed",
      mcpServers: {
        "bad:name": { url: "https://a.example.com/mcp" },
        "bad/name": { url: "https://a.example.com/mcp" },
        "bad name": { url: "https://a.example.com/mcp" },
        notObj: "https://a.example.com/mcp",
        httpUrl: { url: "http://insecure.example.com/mcp" },
        fileUrl: { url: "file:///etc/passwd" },
        spaceUrl: { url: "https://example.com/my mcp" },
        stdioAttempt: { command: "npx", args: ["-y", "foo"] },
        cmdHeader: {
          url: "https://a.example.com/mcp",
          headers: { Authorization: "!echo pwned" },
        },
        emptyHeader: {
          url: "https://a.example.com/mcp",
          headers: { "": "val" },
        },
        badAuth: {
          url: "https://a.example.com/mcp",
          auth: "bearer",
        },
        goodWithExtra: {
          url: "https://ok.example.com/mcp",
          extraKey: true,
        },
      },
    });
    writeProjectConf(cwd, { mixed: { path: dir } });

    const inv = readPluginInventory(cwd);
    const candidate = inv.candidates[0];
    assert.deepEqual(candidate?.plugin?.mcpServers, [
      {
        name: "goodWithExtra",
        url: "https://ok.example.com/mcp",
        headerNames: [],
        auth: null,
        description: null,
      },
    ]);
    const diags = candidate?.diagnostics ?? [];
    assert.ok(diags.some((d) => d.includes("mcpServers.bad:name")));
    assert.ok(diags.some((d) => d.includes("mcpServers.bad/name")));
    assert.ok(diags.some((d) => d.includes("mcpServers.bad name")));
    assert.ok(diags.some((d) => d.includes("mcpServers.notObj")));
    assert.ok(diags.some((d) => d.includes("mcpServers.httpUrl")));
    assert.ok(diags.some((d) => d.includes("mcpServers.fileUrl")));
    assert.ok(diags.some((d) => d.includes("mcpServers.spaceUrl")));
    assert.ok(diags.some((d) => d.includes("mcpServers.stdioAttempt")));
    assert.ok(diags.some((d) => d.includes("mcpServers.cmdHeader") && d.includes("!")));
    assert.ok(diags.some((d) => d.includes("mcpServers.emptyHeader")));
    assert.ok(diags.some((d) => d.includes("mcpServers.badAuth")));
    assert.ok(diags.some((d) => d.includes("mcpServers.goodWithExtra") && d.includes("extraKey")));
  });
});

test("specs/plugin.md#mcp-servers: registers servers in admission and key order, warns on collision, and disposes on shutdown", async () => {
  const plugins: PluginEntry[] = [
    {
      name: "alpha",
      root: "/plugins/alpha",
      commands: [],
      mcpServers: [
        {
          name: "docs",
          url: "https://docs.alpha.example/mcp",
          headers: { "X-Key": "abc" },
          auth: "oauth",
          description: "Alpha docs",
        },
        {
          name: "search",
          url: "https://search.alpha.example/mcp",
        },
      ],
    },
    {
      name: "beta",
      root: "/plugins/beta",
      commands: [],
      mcpServers: [
        {
          name: "api",
          url: "https://api.beta.example/mcp",
        },
      ],
    },
  ];

  const received: Array<{ name: string; definition: unknown }> = [];
  const disposed: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const preExisting = new Set(["alpha:search"]);

  const registrar = createPluginMcpRegistrar(
    {
      emit(channel, data) {
        assert.equal(channel, MCP_RUNTIME_REGISTER_EVENT);
        const req = data as McpRuntimeRegistrationRequest;
        assert.equal(req.version, 1);
        received.push({ name: req.name, definition: req.definition });
        if (preExisting.has(req.name)) {
          req.result = {
            ok: false,
            error: new Error(`MCP server "${req.name}" is already registered`),
          };
          return;
        }
        req.result = {
          ok: true,
          registration: {
            dispose: async () => {
              disposed.push(req.name);
            },
          },
        };
      },
    },
    plugins,
    (d) => diagnostics.push(d),
  );

  registrar.register();
  // Second register before dispose is a no-op.
  registrar.register();

  assert.deepEqual(received, [
    {
      name: "alpha:docs",
      definition: {
        url: "https://docs.alpha.example/mcp",
        headers: { "X-Key": "abc" },
        auth: "oauth",
        description: "Alpha docs",
      },
    },
    {
      name: "alpha:search",
      definition: { url: "https://search.alpha.example/mcp" },
    },
    {
      name: "beta:api",
      definition: { url: "https://api.beta.example/mcp" },
    },
  ]);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]?.message ?? "", /alpha:search.*already registered/);

  await registrar.dispose();
  assert.deepEqual(disposed, ["alpha:docs", "beta:api"]);

  // After dispose, a new session can register cleanly again.
  registrar.register();
  assert.equal(received.length, 6);
});

test("specs/plugin.md#mcp-servers: emits one warning when pi-mcp-adapter is not loaded", () => {
  const plugins: PluginEntry[] = [
    {
      name: "alpha",
      root: "/plugins/alpha",
      commands: [],
      mcpServers: [
        { name: "a", url: "https://a.example/mcp" },
        { name: "b", url: "https://b.example/mcp" },
      ],
    },
  ];
  const diagnostics: Diagnostic[] = [];
  const registrar = createPluginMcpRegistrar(
    {
      emit() {
        // No listener attached: request.result stays undefined.
      },
    },
    plugins,
    (d) => diagnostics.push(d),
  );

  registrar.register();
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]?.message ?? "", /pi-mcp-adapter is not loaded/);
});

test("specs/plugin.md#plugin-manifest & 12: oauth object validates clientId/scope/callbackUrl and maps callbackUrl to redirectUri", () => {
  withIsolatedHome((root, cwd) => {
    const dir = writePlugin(root, "crm", {
      name: "crm",
      mcpServers: {
        "odoo-oauth": {
          url: "https://crm.unitai.dev/api/mcp",
          auth: "oauth",
          oauth: {
            clientId: "pi-odoo-mcp",
            scope: "openid mcp.read mcp.write",
            callbackUrl: "http://127.0.0.1:3118/callback",
            extraOAuthKey: 1,
          },
        },
        noAuth: {
          url: "https://a.example/mcp",
          oauth: { clientId: "x" },
        },
        badOAuthShape: {
          url: "https://a.example/mcp",
          auth: "oauth",
          oauth: "not-an-object",
        },
        missingClientId: {
          url: "https://a.example/mcp",
          auth: "oauth",
          oauth: { scope: "openid" },
        },
        badScope: {
          url: "https://a.example/mcp",
          auth: "oauth",
          oauth: { clientId: "x", scope: "   " },
        },
        badCallback: {
          url: "https://a.example/mcp",
          auth: "oauth",
          oauth: { clientId: "x", callbackUrl: "http://evil.example/cb" },
        },
      },
    });
    writeProjectConf(cwd, { crm: { path: dir } });

    const diagnostics: Diagnostic[] = [];
    const catalog = discoverPlugins(readConfig(cwd), diagnostics);
    assert.equal(catalog.plugins.length, 1);
    assert.deepEqual(catalog.plugins[0]?.mcpServers, [
      {
        name: "odoo-oauth",
        url: "https://crm.unitai.dev/api/mcp",
        auth: "oauth",
        oauth: {
          clientId: "pi-odoo-mcp",
          scope: "openid mcp.read mcp.write",
          callbackUrl: "http://127.0.0.1:3118/callback",
        },
      },
    ]);
    const msgs = diagnostics.map((d) => d.message);
    assert.ok(msgs.some((m) => m.includes("odoo-oauth.oauth") && m.includes("extraOAuthKey")));
    assert.ok(msgs.some((m) => m.includes("mcpServers.noAuth") && m.includes("requires auth")));
    assert.ok(msgs.some((m) => m.includes("mcpServers.badOAuthShape")));
    assert.ok(msgs.some((m) => m.includes("mcpServers.missingClientId")));
    assert.ok(msgs.some((m) => m.includes("mcpServers.badScope")));
    assert.ok(msgs.some((m) => m.includes("mcpServers.badCallback")));

    const sent: Array<{ name: string; definition: unknown }> = [];
    const regDiagnostics: Diagnostic[] = [];
    const registrar = createPluginMcpRegistrar(
      {
        emit(_channel, data) {
          const req = data as McpRuntimeRegistrationRequest;
          sent.push({ name: req.name, definition: req.definition });
          req.result = { ok: true, registration: { dispose: async () => {} } };
        },
      },
      catalog.plugins,
      (d) => regDiagnostics.push(d),
    );
    registrar.register();
    assert.deepEqual(regDiagnostics, []);
    assert.deepEqual(sent, [
      {
        name: "crm:odoo-oauth",
        definition: {
          url: "https://crm.unitai.dev/api/mcp",
          auth: "oauth",
          oauth: {
            clientId: "pi-odoo-mcp",
            scope: "openid mcp.read mcp.write",
            redirectUri: "http://127.0.0.1:3118/callback",
          },
        },
      },
    ]);
  });
});
