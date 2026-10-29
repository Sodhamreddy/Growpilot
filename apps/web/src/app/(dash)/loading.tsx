import { LoadingIndicator } from "@/components/LoadingIndicator";

export default function DashboardLoading() {
  return (
    <div className="dashboard-loading">
      <LoadingIndicator label="Loading page…" size="large" />
    </div>
  );
}
