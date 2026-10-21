/**
 * Per-vulnerability hardening switch.
 *
 * DVAP is vulnerable by default. `DVAP_HARDEN=V7,V15` (or `all`) turns on the fix for those bug IDs.
 * Evaluated at call time so tests and live demos can flip it without restarting code paths that re-read env.
 * IDs follow docs/PUBLIC_BUG_LESSONS.md and docs/BUG_CATALOG.md (e.g. V7 = unpinned 402 challenge, V15 = paywall route-gate bypass).
 */
export function hardened(id: string): boolean {
  const raw = (process.env.DVAP_HARDEN ?? '').trim();
  if (!raw) return false;
  const set = new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  return set.has('ALL') || set.has(id.toUpperCase());
}
