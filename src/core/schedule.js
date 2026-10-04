import { HornetError } from "./errors.js";

const LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(field, [min, max], isDow = false) {
  const values = new Set();
  for (const part of String(field).split(",")) {
    if (!part) throw new Error("empty cron list item");
    const pieces = part.split("/");
    if (pieces.length > 2) throw new Error("invalid step syntax");
    const step = pieces.length === 2 ? Number(pieces[1]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error("invalid step");
    const base = pieces[0];
    let start;
    let end;
    if (base === "*") [start, end] = [min, max];
    else {
      const range = base.split("-");
      if (range.length > 2 || !range.every((value) => /^\d+$/.test(value))) throw new Error("invalid range");
      start = Number(range[0]);
      end = range.length === 2 ? Number(range[1]) : start;
    }
    if (start < min || end > max || start > end) throw new Error("cron value out of range");
    for (let value = start; value <= end; value += step) values.add(isDow && value === 7 ? 0 : value);
  }
  return values;
}

function parsedFields(expression) {
  const parts = String(expression || "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("expected five fields");
  return parts.map((part, index) => parseField(part, LIMITS[index], index === 4));
}

function matchesParsed(parts, fields, date) {
  const [minutes, hours, days, months, weekdays] = fields;
  const domMatch = days.has(date.getUTCDate());
  const dowMatch = weekdays.has(date.getUTCDay());
  const dayMatch = parts[2] === "*" ? dowMatch : parts[4] === "*" ? domMatch : domMatch || dowMatch;
  return minutes.has(date.getUTCMinutes()) && hours.has(date.getUTCHours()) && dayMatch && months.has(date.getUTCMonth() + 1);
}

export function cronMatchesUtc(expression, date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return false;
  try { return matchesParsed(String(expression || "").trim().split(/\s+/), parsedFields(expression), date); } catch { return false; }
}

export function nextCronOccurrenceUtc(expression, after = new Date()) {
  let fields;
  try { fields = parsedFields(expression); } catch {
    throw new HornetError("invalid_schedule", "Only valid five-field UTC cron schedules are supported.", { status: 400 });
  }
  const parts = String(expression || "").trim().split(/\s+/);
  const cursor = new Date(after);
  if (!Number.isFinite(cursor.getTime())) throw new HornetError("invalid_schedule_time", "The schedule reference time is invalid.", { status: 400 });
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const maxMinutes = 366 * 24 * 60;
  for (let i = 0; i < maxMinutes; i += 1) {
    if (matchesParsed(parts, fields, cursor)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new HornetError("schedule_no_occurrence", "No matching UTC schedule was found within one year.", { status: 400 });
}
