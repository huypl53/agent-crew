// Max chars for worker → leader completion notifications.
// Covers most worker reports without overwhelming leader's pane.
const NOTIFY_MAX_CHARS = (() => {
  const parsed = Number(process.env.CREW_NOTIFY_MAX_CHARS ?? 5000);
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : 5000;
})();

export const config = {
  // Sender verification mode:
  //   off      — disabled (no check)
  //   log      — warn on mismatch, continue (default)
  //   enforce  — reject on mismatch
  senderVerification: (process.env.CREW_SENDER_VERIFICATION || 'log') as
    | 'off'
    | 'log'
    | 'enforce',

  // Polling profile:
  //   conservative — 500ms fixed interval
  //   reduced      — role-based: worker=2s, leader=5s (default)
  pollingProfile: (process.env.CREW_POLLING_PROFILE || 'reduced') as
    | 'conservative'
    | 'reduced',

  // Leader inbound pacing between consecutive paste deliveries (ms)
  leaderPaceMs: (() => {
    const parsed = Number(process.env.CREW_LEADER_PACE_MS ?? 7000);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 7000;
  })(),

  // Max chars for worker → leader completion notifications
  notifyMaxChars: NOTIFY_MAX_CHARS,
};
