import assert from "node:assert/strict";
import test from "node:test";
import { momentFormatToRegex, parseDateFromBasename } from "../src/dates";

test("matches Daily Note basenames and rejects non-journal notes", () => {
  const pattern = momentFormatToRegex("YYYY-MM-DD");
  assert.ok(pattern);

  const dailyNote = parseDateFromBasename("2026-09-24", pattern);
  assert.ok(dailyNote);
  assert.equal(dailyNote.getFullYear(), 2026);
  assert.equal(dailyNote.getMonth(), 8);
  assert.equal(dailyNote.getDate(), 24);

  assert.equal(parseDateFromBasename("Project planning", pattern), null);
  assert.equal(parseDateFromBasename("2026-09", pattern), null);
  assert.equal(parseDateFromBasename("Project 2026-09-24", pattern), null);
});
