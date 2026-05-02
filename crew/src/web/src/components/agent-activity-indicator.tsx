/** Animated dot showing agent activity status */
export default function AgentActivityIndicator({ status }: { status?: string }) {
  if (!status || status === 'idle' || status === 'dead') return null;

  const color =
    status === 'thinking'
      ? 'bg-blue-400'
      : status === 'reading'
        ? 'bg-amber-400'
        : 'bg-green-400';

  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full ${color} animate-pulse`}
      aria-label={`Agent is ${status}`}
      title={status}
    />
  );
}
