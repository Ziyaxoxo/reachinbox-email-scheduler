export function TableSkeleton() {
  return (
    <div className="panel overflow-hidden" aria-busy="true" aria-label="Loading">
      <div className="list-head pointer-events-none">
        <span className="w-[132px] shrink-0">Recipient</span>
        <span className="flex-1">Email</span>
        <span className="w-[104px] shrink-0 text-right">Time</span>
        <span className="w-7" />
      </div>
      <div className="divide-y divide-line">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="sk h-3 w-[120px]" />
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <div className="sk h-5 w-16 rounded-pill" />
              <div className="sk h-3 flex-1 max-w-[260px]" />
            </div>
            <div className="sk h-3 w-[72px]" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="panel p-4 space-y-3" aria-busy="true" aria-label="Loading">
      <div className="sk h-3 w-24" />
      <div className="sk h-3 w-full" />
      <div className="sk h-3 w-2/3" />
    </div>
  );
}
