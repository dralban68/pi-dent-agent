import assert from "node:assert/strict";
import test from "node:test";
import { localStamp, parseDateTime } from "../../lib/schedule-time.ts";
import { must } from "../support/must.ts";

test("Section 2.2: an RFC 3339 date-time parses to the instant Date.parse names", () => {
  const accepted = [
    "2026-11-12T07:47:38Z",
    "2026-11-12T07:47:38z",
    "2026-11-12t07:47:38Z",
    "2026-11-12T07:47:38+02:00",
    "2026-11-12T07:47:38-05:30",
    "2026-11-12T07:47:38.5Z",
    "2026-11-12T07:47:38.123Z",
    "2026-11-12T07:47:38.123456Z",
    "2024-02-29T00:00:00Z",
    "2000-02-29T12:00:00Z",
    "1970-01-01T00:00:00Z",
    "0001-01-01T00:00:00Z",
    "9999-12-31T23:59:59Z",
  ];
  for (const text of accepted) {
    assert.equal(parseDateTime(text), Date.parse(text), text);
  }
});

test("Section 2.2: the offset -00:00 denotes UTC", () => {
  assert.equal(parseDateTime("2026-11-12T07:47:38-00:00"), parseDateTime("2026-11-12T07:47:38Z"));
});

test("Section 2.2: fractional seconds are truncated to whole milliseconds", () => {
  assert.equal(
    parseDateTime("2026-11-12T07:47:38.1239Z"),
    must(parseDateTime("2026-11-12T07:47:38Z")) + 123,
  );
  assert.equal(parseDateTime("2026-11-12T07:47:38.0004Z"), parseDateTime("2026-11-12T07:47:38Z"));
});

test("Section 2.2: an offset shifts the instant", () => {
  const utc = parseDateTime("2026-11-12T07:47:38Z");
  assert.equal(parseDateTime("2026-11-12T09:47:38+02:00"), utc);
  assert.equal(parseDateTime("2026-11-12T02:17:38-05:30"), utc);
});

test("Section 2.2: values that are no date-time or no valid date parse to nothing", () => {
  const rejected = [
    "",
    "2026-11-12",
    "07:47:38",
    "2026-11-12 07:47:38Z",
    "2026-11-12T07:47:38",
    "2026-11-12T07:47Z",
    "2026-11-12T07:47:38+0200",
    "2026-11-12T07:47:38.Z",
    "2026-11-12T07:47:38,5Z",
    "2026-11-12T24:00:00Z",
    "2026-11-12T07:60:00Z",
    "2026-11-12T07:47:60Z",
    "2026-13-01T00:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-01-00T00:00:00Z",
    "2026-01-32T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2100-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-11-12T07:47:38+24:00",
    "2026-11-12T07:47:38+02:60",
    "+2026-11-12T07:47:38Z",
    "2026-11-12T07:47:38Z ",
    "2026-11-12T07:47:38ZZ",
  ];
  for (const text of rejected) {
    assert.equal(parseDateTime(text), undefined, text);
  }
  assert.equal(parseDateTime("2026-11-12T07:47:38+19:59"), parseDateTime("2026-11-11T11:48:38Z"));
});

test("Section 2.2: a local time stamp renders the date, 24-hour time, and offset of its zone", () => {
  const instant = Date.parse("2026-11-12T07:47:38Z");
  // Literal strings: the stamp follows the zone argument, not the process zone.
  assert.equal(localStamp(instant, "Asia/Kolkata"), "2026-11-12T13:17:38+05:30");
  assert.equal(localStamp(instant, "America/New_York"), "2026-11-12T02:47:38-05:00");
  assert.equal(localStamp(instant, "UTC"), "2026-11-12T07:47:38+00:00");
  // The offset in force at the instant, not the one at another date.
  assert.equal(
    localStamp(Date.parse("2026-07-01T12:00:00Z"), "America/New_York"),
    "2026-07-01T08:00:00-04:00",
  );
  // Whole seconds rounded down.
  assert.equal(localStamp(instant + 999, "UTC"), "2026-11-12T07:47:38+00:00");
  assert.notEqual(localStamp(instant, "UTC"), localStamp(instant + 1000, "UTC"));
  assert.equal(localStamp(0, "UTC"), "1970-01-01T00:00:00+00:00");
  assert.equal(localStamp(0, "Asia/Kolkata"), "1970-01-01T05:30:00+05:30");
});
