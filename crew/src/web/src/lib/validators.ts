/** Validates a room name. Returns an error string or null if valid. */
export function validateRoomName(name: string): string | null {
  if (!name.trim()) return 'Name required';
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name.trim())) return 'Letters, digits, - or _ only (max 32)';
  return null;
}

/** Validates a capabilities JSON string. Returns an error string or null if valid. */
export function validateCapabilities(json: string): string | null {
  if (!json.trim()) return null; // empty is allowed
  try { JSON.parse(json); return null; }
  catch { return 'Must be valid JSON'; }
}
