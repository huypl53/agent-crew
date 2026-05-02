/** Skeleton loading placeholders with prefers-reduced-motion support */

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`bg-slate-200 dark:bg-slate-700 rounded animate-pulse motion-reduce:animate-none ${className}`}
      aria-hidden="true"
    />
  );
}

export function SkeletonRow({ count = 1 }: { count?: number }) {
  return (
    <div className="space-y-2 p-3" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex gap-3 items-center">
          <div className="bg-slate-200 dark:bg-slate-700 rounded animate-pulse motion-reduce:animate-none h-3 w-16" />
          <div className="bg-slate-200 dark:bg-slate-700 rounded animate-pulse motion-reduce:animate-none h-3 flex-1 max-w-xs" />
          <div className="bg-slate-200 dark:bg-slate-700 rounded animate-pulse motion-reduce:animate-none h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2 p-3" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-slate-100 dark:bg-slate-800/50 rounded px-3 py-2 flex gap-2 items-baseline">
          <div className="bg-slate-200 dark:bg-slate-700 rounded animate-pulse motion-reduce:animate-none h-3 w-12 flex-shrink-0" />
          <div className="bg-slate-200 dark:bg-slate-700 rounded animate-pulse motion-reduce:animate-none h-3 w-16 flex-shrink-0" />
          <div className="bg-slate-200 dark:bg-slate-700 rounded animate-pulse motion-reduce:animate-none h-3 flex-1" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonStat({ count = 4 }: { count?: number }) {
  return (
    <div className="flex gap-3 px-4 py-1.5" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-1">
          <div className="bg-slate-200 dark:bg-slate-700 rounded animate-pulse motion-reduce:animate-none h-3 w-8" />
          <div className="bg-slate-200 dark:bg-slate-700 rounded animate-pulse motion-reduce:animate-none h-3 w-6" />
        </div>
      ))}
    </div>
  );
}
