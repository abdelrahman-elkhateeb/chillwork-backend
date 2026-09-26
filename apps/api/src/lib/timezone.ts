/** True for a valid IANA timezone name (e.g. "Africa/Cairo"), per the runtime's tz database. */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
