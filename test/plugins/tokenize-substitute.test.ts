import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPluginCommand, substituteArgs, tokenizeArgs } from "../../lib/plugins.ts";

/**
 * Argument tokenization and substitution per specs/plugin.md Section 6:
 * unit tests over the pure functions. Tool-level behavior (omitted args,
 * insertion into real resource bodies) lives in plugin-tool.test.ts.
 */

test("tokenizer: splits on whitespace runs", () => {
  assert.deepEqual(tokenizeArgs("a b  c\t\nd"), ["a", "b", "c", "d"]);
  assert.deepEqual(tokenizeArgs("   "), []);
  assert.deepEqual(tokenizeArgs(""), []);
});

test("tokenizer: quoting and escapes do not exist; quotes are ordinary characters", () => {
  assert.deepEqual(tokenizeArgs('a "b c" d'), ["a", '"b', 'c"', "d"]);
  assert.deepEqual(tokenizeArgs("a 'b c' d"), ["a", "'b", "c'", "d"]);
  assert.deepEqual(tokenizeArgs('""'), ['""']);
  assert.deepEqual(tokenizeArgs("a\\b"), ["a\\b"]);
  assert.deepEqual(tokenizeArgs("C:\\dir\\file"), ["C:\\dir\\file"]);
  assert.deepEqual(tokenizeArgs('a\\ "b'), ["a\\", '"b']);
});

test("substitution: omitted-token indices expand to the empty string", () => {
  assert.equal(substituteArgs("x $3 y", "a b"), "x  y");
  assert.equal(substituteArgs("price: $5", "a"), "price: ");
});

test("substitution: $N is 1-based with greedy digits", () => {
  assert.equal(substituteArgs("$1", "a b"), "a");
  assert.equal(substituteArgs("$2", "a b"), "b");
  assert.equal(substituteArgs("$1$2", "a b"), "ab");
  // Greedy: "$12" is the twelfth token, not "$1" followed by a literal 2.
  const twelve = Array.from({ length: 12 }, (_, i) => `t${i + 1}`).join(" ");
  assert.equal(substituteArgs("$12", twelve), "t12");
  assert.equal(substituteArgs("$12", "a b"), "");
  assert.equal(substituteArgs("$10", twelve), "t10");
});

test("substitution: $N takes a token of the whitespace-run tokenization", () => {
  assert.equal(substituteArgs("$1", 'a "b c"'), "a");
  assert.equal(substituteArgs("$2", 'a "b c"'), '"b');
  assert.equal(substituteArgs("$3", 'a "b c"'), 'c"');
});

test("substitution: $ARGUMENTS expands to the full raw args string, with no word boundary", () => {
  const args = 'a "b c"';
  assert.equal(substituteArgs("$ARGUMENTS", args), args);
  assert.equal(substituteArgs("pre $ARGUMENTS post", args), `pre ${args} post`);
  assert.equal(substituteArgs("$ARGUMENTS", ""), "");
  // No word-boundary condition: a following word character does not stop it.
  assert.equal(substituteArgs("$ARGUMENTSX", "a b"), "a bX");
  assert.equal(substituteArgs("$ARGUMENTS_1", "a b"), "a b_1");
});

test("substitution: $0 and every other $ sequence stay literal", () => {
  assert.equal(substituteArgs("$0", "a"), "$0");
  assert.equal(substituteArgs("$@", "a b"), "$@");
  assert.equal(substituteArgs("pre $@ post", "a b"), "pre $@ post");
  assert.equal(substituteArgs("${@:1}", "a b"), "${@:1}");
  assert.equal(substituteArgs("${@:2:1}", "a b"), "${@:2:1}");
  assert.equal(substituteArgs("$x", "a"), "$x");
  assert.equal(substituteArgs("a$b", "a"), "a$b");
  assert.equal(substituteArgs("$", "a"), "$");
  assert.equal(substituteArgs("$$", "a"), "$$");
  assert.equal(substituteArgs("$ARG", "a"), "$ARG");
});

test("substitution: inserted token values are verbatim and never re-scanned", () => {
  // The token "$2" must land as the literal text "$2".
  assert.equal(substituteArgs("$2", "x $2 y"), "$2");
  assert.equal(substituteArgs("$1", "$ARGUMENTS"), "$ARGUMENTS");
  assert.equal(substituteArgs("$1", "${@:1}"), "${@:1}");
  assert.equal(substituteArgs("$ARGUMENTS", "$1"), "$1");
  assert.equal(substituteArgs("$1 $2", "$@ $1"), "$@ $1");
});

test("substitution: one pass over a mixed body", () => {
  const body = "cmd $1 --rest $2 --all $ARGUMENTS tail $@";
  assert.equal(substituteArgs(body, 'run "a b" c'), 'cmd run --rest "a --all run "a b" c tail $@');
});

test("substitution: a body with no tokens is unchanged", () => {
  assert.equal(substituteArgs("plain text", "a b"), "plain text");
});

test("renderPluginCommand trims the slash-command argument string before substitution (plugin.md Section 5)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-command-"));
  try {
    mkdirSync(join(root, "commands"));
    writeFileSync(
      join(root, "commands", "echo.md"),
      "---\ndescription: echo\n---\n[$ARGUMENTS]|$1|$2\n",
    );
    assert.equal(renderPluginCommand(root, "echo", "  a  b  "), "[a  b]|a|b");
    assert.equal(renderPluginCommand(root, "echo", "   "), "[]||");
    assert.equal(renderPluginCommand(root, "echo", ""), "[]||", "no arguments substitute empties");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderPluginCommand returns the body with the skill.md Section 2 normalisation (plugin.md Section 5)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-command-"));
  try {
    mkdirSync(join(root, "commands"));
    const body = (name: string, text: string) => {
      writeFileSync(join(root, "commands", `${name}.md`), text);
      return renderPluginCommand(root, name, "");
    };
    assert.equal(
      body("frontmatter", "---\ndescription: d\n---\n\n  line one\nline two\n\n"),
      "line one\nline two",
      "a frontmattered body is trimmed",
    );
    assert.equal(
      body("no-frontmatter", "\uFEFF\n\r\n  plain  \r\nbody \r\n\n"),
      "plain  \nbody",
      "a body without frontmatter loses the byte-order mark, gets \\n line endings, and is trimmed",
    );
    assert.equal(
      body("unclosed", "---\ndescription: d\n\n  text  \n"),
      "---\ndescription: d\n\n  text",
      "an unclosed frontmatter leaves the whole text as body, trimmed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
