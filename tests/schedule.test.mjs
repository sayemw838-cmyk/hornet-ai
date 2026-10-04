import assert from "node:assert/strict";
import test from "node:test";
import { cronMatchesUtc, nextCronOccurrenceUtc } from "../src/core/schedule.js";

test("UTC cron supports lists, ranges and steps with calendar matching", () => {
  assert.equal(cronMatchesUtc("*/15 9-10 * * 1-5", new Date("2026-10-05T09:30:00Z")), true);
  assert.equal(cronMatchesUtc("0 9 * * 1-5", new Date("2026-10-04T09:00:00Z")), false);
  assert.equal(cronMatchesUtc("0 0 1 * 1", new Date("2026-10-05T00:00:00Z")), true); // DOM/DOW are OR when both constrained.
});

test("next occurrence is minute-aligned and strictly after the supplied instant", () => {
  assert.equal(nextCronOccurrenceUtc("0 9 * * *", new Date("2026-10-04T09:00:00Z")).toISOString(), "2026-10-05T09:00:00.000Z");
  assert.equal(nextCronOccurrenceUtc("*/5 * * * *", new Date("2026-10-04T10:01:30Z")).toISOString(), "2026-10-04T10:05:00.000Z");
});

test("invalid or unsupported cron values fail closed", () => {
  assert.throws(() => nextCronOccurrenceUtc("61 * * * *", new Date()), (error) => error.code === "invalid_schedule");
  assert.equal(cronMatchesUtc("* * *", new Date()), false);
  assert.throws(() => nextCronOccurrenceUtc("*/0 * * * *", new Date()), (error) => error.code === "invalid_schedule");
});
