import { memo, useMemo, useState, useCallback } from 'react';
import { useMetricsStore } from '../stores/useMetricsStore';
import { useThemeStore } from '../stores/useThemeStore';

// Empty array constant to avoid creating new references in selectors
const EMPTY_METRICS_HISTORY: { timestamp: number; cpu: number; memoryPercent: number; memoryUsed: number; diskPercent: number; diskUsed: number }[] = [];

// Compact sparkline for ServerCard
interface SparklineProps {
  serverId: string;
  metric: 'cpu' | 'memory' | 'disk';
  color?: string;
  height?: number;
  width?: number;
  total?: number; // Total bytes for memory/disk to show GB scale
}

export const Sparkline = memo(function Sparkline({
  serverId,
  metric,
  color,
  height = 32,
  width = 90,
  total,
}: SparklineProps) {
  const history = useMetricsStore((state) => state.history[serverId] ?? EMPTY_METRICS_HISTORY);
  const theme = useThemeStore((state) => state.theme);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  const data = useMemo(() => {
    // Get last 20 data points
    const recent = history.slice(-20);
    return recent.map((point) => {
      if (metric === 'cpu') {
        return { percent: point.cpu, raw: point.cpu };
      }
      if (metric === 'memory') {
        return { percent: point.memoryPercent, raw: point.memoryUsed };
      }
      return { percent: point.diskPercent, raw: point.diskUsed };
    });
  }, [history, metric]);

  const formatTooltip = (raw: number) => {
    if (metric === 'cpu') {
      return `${raw.toFixed(1)}%`;
    }
    // Format bytes to GB
    const gb = raw / (1024 * 1024 * 1024);
    return `${gb.toFixed(1)} GB`;
  };

  const defaultColors = {
    cpu: '#f59e0b',
    memory: '#3b82f6',
    disk: '#10b981',
  };

  const chartColor = color || defaultColors[metric];
  const textColor = theme === 'dark' ? '#6b7280' : '#9ca3af';
  const gridColor = theme === 'dark' ? '#374151' : '#e5e7eb';

  // Format GB value for labels
  const formatGB = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 100) return `${Math.round(gb)}`;
    if (gb >= 10) return `${Math.round(gb)}`;
    return `${gb.toFixed(0)}`;
  };

  // Get scale labels based on metric type
  const getScaleLabels = () => {
    if (metric === 'cpu' || !total) {
      return { top: '100', mid: '50', bottom: '0' };
    }
    return {
      top: formatGB(total),
      mid: formatGB(total / 2),
      bottom: '0',
    };
  };

  const scaleLabels = getScaleLabels();

  // Padding for labels
  const leftPadding = 28;
  const chartWidth = width - leftPadding;

  // Calculate SVG path (only if we have data)
  const points = useMemo(() => {
    if (data.length < 2) return [];
    const max = 100;
    const min = 0;
    const range = max - min || 1;
    return data.map((d, i) => {
      const x = leftPadding + (i / (data.length - 1)) * chartWidth;
      const y = height - ((d.percent - min) / range) * height;
      return { x, y, percent: d.percent, raw: d.raw };
    });
  }, [data, leftPadding, chartWidth, height]);

  const pathD = useMemo(() => {
    if (points.length < 2) return '';
    return `M ${points.map(p => `${p.x},${p.y}`).join(' L ')}`;
  }, [points]);

  // Hooks must be called unconditionally - before any early returns
  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;

    // Find closest point
    if (x >= leftPadding && data.length > 1) {
      const chartX = x - leftPadding;
      const index = Math.round((chartX / chartWidth) * (data.length - 1));
      const clampedIndex = Math.max(0, Math.min(data.length - 1, index));
      setHoveredIndex(clampedIndex);
      setMousePos({ x: e.clientX, y: e.clientY });
    }
  }, [leftPadding, chartWidth, data.length]);

  const handleMouseLeave = useCallback(() => {
    setHoveredIndex(null);
    setMousePos(null);
  }, []);

  // Early return AFTER all hooks
  if (data.length < 2) {
    return <div style={{ width, height }} className="flex items-center justify-center text-[10px] text-muted">No data</div>;
  }

  return (
    <div className="relative">
      <svg
        width={width}
        height={height}
        className="overflow-visible"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* Y-axis labels */}
        <text x={leftPadding - 2} y={6} textAnchor="end" fontSize={8} fill={textColor}>{scaleLabels.top}</text>
        <text x={leftPadding - 2} y={height / 2 + 3} textAnchor="end" fontSize={8} fill={textColor}>{scaleLabels.mid}</text>
        <text x={leftPadding - 2} y={height} textAnchor="end" fontSize={8} fill={textColor}>{scaleLabels.bottom}</text>

        {/* Grid lines */}
        <line x1={leftPadding} y1={0} x2={width} y2={0} stroke={gridColor} strokeWidth={0.5} strokeDasharray="2,2" />
        <line x1={leftPadding} y1={height / 2} x2={width} y2={height / 2} stroke={gridColor} strokeWidth={0.5} strokeDasharray="2,2" />
        <line x1={leftPadding} y1={height} x2={width} y2={height} stroke={gridColor} strokeWidth={0.5} strokeDasharray="2,2" />

        {/* Line */}
        <path
          d={pathD}
          fill="none"
          stroke={chartColor}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Hover dot */}
        {hoveredIndex !== null && points[hoveredIndex] && (
          <circle
            cx={points[hoveredIndex].x}
            cy={points[hoveredIndex].y}
            r={3}
            fill={chartColor}
          />
        )}
      </svg>

      {/* Tooltip */}
      {hoveredIndex !== null && mousePos && points[hoveredIndex] && (
        <div
          className="fixed z-50 px-2 py-1 text-xs rounded shadow-lg pointer-events-none"
          style={{
            left: mousePos.x + 10,
            top: mousePos.y - 10,
            backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
            border: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
          }}
        >
          {formatTooltip(points[hoveredIndex].raw)}
        </div>
      )}
    </div>
  );
});
