"use client";

import { useState } from "react";

export interface SocialChartPoint {
  date: string;
  reach: number;
  engagement: number;
  likes: number;
}

const COLORS = { reach: "#1e73e8", engagement: "#7656ed", likes: "#ee3c93" } as const;

function polyline(data: SocialChartPoint[], metric: keyof typeof COLORS): string {
  const max = Math.max(...data.map((point) => point[metric]), 1);
  return data.map((point, index) => {
    const x = (index / Math.max(data.length - 1, 1)) * 100;
    const y = 90 - (point[metric] / max) * 72;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

export function SocialInsightsChart({ data }: { data: SocialChartPoint[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const active = hovered === null ? null : data[hovered];
  const x = hovered === null ? 0 : (hovered / Math.max(data.length - 1, 1)) * 100;

  function locate(clientX: number, element: SVGSVGElement) {
    const bounds = element.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    setHovered(Math.round(ratio * Math.max(data.length - 1, 0)));
  }

  return <div className="si-chart-interactive" onMouseLeave={() => setHovered(null)}>
    <svg className="si-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
      aria-label="Daily social performance chart"
      onMouseMove={(event) => locate(event.clientX, event.currentTarget)}
      onTouchMove={(event) => locate(event.touches[0]?.clientX ?? 0, event.currentTarget)}>
      <line x1="0" y1="25" x2="100" y2="25"/><line x1="0" y1="50" x2="100" y2="50"/><line x1="0" y1="75" x2="100" y2="75"/>
      <polyline className="reach-line" points={polyline(data, "reach")}/>
      <polyline className="engagement-line" points={polyline(data, "engagement")}/>
      <polyline className="likes-line" points={polyline(data, "likes")}/>
      {active ? <><line className="si-hover-line" x1={x} x2={x} y1="8" y2="91"/>
        {(Object.keys(COLORS) as (keyof typeof COLORS)[]).map((metric) => {
          const max = Math.max(...data.map((point) => point[metric]), 1);
          const y = 90 - (active[metric] / max) * 72;
          return <circle key={metric} cx={x} cy={y} r="1.2" fill={COLORS[metric]}/>;
        })}</> : null}
    </svg>
    {active ? <div className="si-chart-tooltip" style={{ left: `${Math.min(82, Math.max(4, x))}%` }}>
      <strong>{new Date(`${active.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</strong>
      <span><i style={{ background: COLORS.reach }}/>Reach <b>{active.reach.toLocaleString()}</b></span>
      <span><i style={{ background: COLORS.engagement }}/>Engagement <b>{active.engagement.toLocaleString()}</b></span>
      <span><i style={{ background: COLORS.likes }}/>Likes <b>{active.likes.toLocaleString()}</b></span>
    </div> : null}
  </div>;
}
