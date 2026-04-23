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
  //   reduced      — role-based: leader=2s, worker=5s, boss=10s (default)
  pollingProfile: (process.env.CREW_POLLING_PROFILE || 'reduced') as
    | 'conservative'
    | 'reduced',
};
