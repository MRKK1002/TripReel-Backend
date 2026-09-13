const IST_OFFSET_MINUTES = 330;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  )
    return null;
  return { year, month, day, key: `${match[1]}-${match[2]}-${match[3]}` };
}

function dateKeyToISTStart(value) {
  const parsed = parseDateKey(value);
  if (!parsed) return null;
  return new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day) -
      IST_OFFSET_MINUTES * 60 * 1000,
  );
}

function getISTDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function addDaysToDateKey(value, days) {
  const start = dateKeyToISTStart(value);
  if (!start || !Number.isInteger(days)) return null;
  return getISTDateKey(new Date(start.getTime() + days * DAY_MS));
}

function getISTDayRange(value) {
  const key = parseDateKey(value)?.key || getISTDateKey(value);
  const start = dateKeyToISTStart(key);
  if (!start) return null;
  return { key, start, endExclusive: new Date(start.getTime() + DAY_MS) };
}

function storedDateKey(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && parseDateKey(value))
    return parseDateKey(value).key;
  return getISTDateKey(value);
}

function isDateKeyPastInclusiveEnd(value, now = new Date()) {
  const key = storedDateKey(value);
  const range = key && getISTDayRange(key);
  return !range || now >= range.endExclusive;
}

function isDateKeyStarted(value, now = new Date()) {
  const key = storedDateKey(value);
  const range = key && getISTDayRange(key);
  return !range || now >= range.start;
}

module.exports = {
  DAY_MS,
  IST_OFFSET_MINUTES,
  parseDateKey,
  dateKeyToISTStart,
  getISTDateKey,
  addDaysToDateKey,
  getISTDayRange,
  storedDateKey,
  isDateKeyPastInclusiveEnd,
  isDateKeyStarted,
};
