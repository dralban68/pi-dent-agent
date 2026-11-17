import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { renderRecapEntry, type RecapTheme } from "../../lib/recap-render.ts";

const theme: RecapTheme = {
  fg: (color, text) => `\u001b[${color === "customMessageLabel" ? "35" : "37"}m${text}\u001b[39m`,
  bg: (_color, text) => `\u001b[45m${text}\u001b[49m`,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
};
const entry = {
  data: {
    text: "Goal: ship\nDone:\n- code\n- tests\nOpen: review\nNext: commit\nLiteral # heading and **stars**",
  },
};

function lines(data: { data?: unknown }, width = 100) {
  return renderRecapEntry(data, { expanded: false }, theme).render(width);
}

test("recap renders a labelled chat box with distinct header, bold line-start labels and plain bullets", () => {
  const rendered = lines(entry);
  const raw = rendered.join("\n");
  const plain = rendered.map((line) => stripVTControlCharacters(line).trim());
  assert.ok(plain.includes("Recap"));
  for (const line of entry.data.text.split("\n")) assert.ok(plain.includes(line));
  assert.ok(raw.includes("\u001b[35m\u001b[1mRecap"));
  for (const label of ["Goal:", "Done:", "Open:", "Next:"]) {
    assert.ok(raw.includes(`\u001b[37m\u001b[1m${label}\u001b[22m`));
  }
  assert.ok(raw.includes("\u001b[45m"));
  assert.ok(raw.includes("\u001b[37m- code"));
  assert.ok(plain.includes("Literal # heading and **stars**"));
});

test("recap only bolds labels at line start and wraps at the terminal width", () => {
  const rendered = lines(
    { data: { text: "Goal: a long goal that wraps\nLiteral Next: not a label" } },
    20,
  );
  assert.ok(rendered.length > 5);
  assert.ok(!rendered.join("\n").includes("\u001b[1mNext:"));
  for (const line of rendered) assert.ok(stripVTControlCharacters(line).length <= 20);
});

test("recap renders identically after reload or expansion and reports malformed persisted data", () => {
  assert.deepEqual(renderRecapEntry(entry, { expanded: true }, theme).render(100), lines(entry));
  for (const data of [undefined, null, "text", {}, { text: 12 }]) {
    assert.match(
      lines({ data }).map(stripVTControlCharacters).join("\n"),
      /Recap unavailable: invalid entry data\./,
    );
  }
});
