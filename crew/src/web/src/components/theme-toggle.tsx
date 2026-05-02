export default function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: 'dark' | 'light';
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      className="px-2 py-1 text-slate-400 hover:text-slate-200 transition-colors text-sm"
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
