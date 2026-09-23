export default function DashboardLoading() {
  return (
    <div className="dashboard-loading" role="status" aria-label="Loading dashboard page">
      <div className="loading-head"><i /><i /></div>
      <div className="loading-metrics">{[0, 1, 2, 3].map((n) => <i key={n} />)}</div>
      <div className="loading-panel"><i /><i /><i /><i /></div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
