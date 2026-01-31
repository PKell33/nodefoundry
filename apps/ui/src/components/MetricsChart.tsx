import { memo, useMemo, useState, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useMetricsStore, formatMetricsForChart } from '../stores/useMetricsStore';
import { useThemeStore } from '../stores/useThemeStore';

interface MetricsChartProps {
  serverId: string;
  height?: number;
  showLegend?: boolean;
}

// Empty array constant to avoid creating new references in selectors
const EMPTY_METRICS_HISTORY: { timestamp: number; cpu: number; memoryPercent: number; memoryUsed: number; diskPercent: number; diskUsed: number }[] = [];

const MetricsChart = memo(function MetricsChart({ serverId, height = 200, showLegend = true }: MetricsChartProps) {
  const history = useMetricsStore((state) => state.history[serverId] ?? EMPTY_METRICS_HISTORY);
  const theme = useThemeStore((state) => state.theme);

  const data = useMemo(() => formatMetricsForChart(history), [history]);

  const colors = {
    cpu: '#f59e0b', // amber
    memory: '#3b82f6', // blue
    disk: '#10b981', // emerald
  };

  const gridColor = theme === 'dark' ? '#374151' : '#e5e7eb';
  const textColor = theme === 'dark' ? '#9ca3af' : '#6b7280';

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm"
        style={{ height }}
      >
        <span className="text-gray-400 dark:text-gray-500">
          Waiting for metrics...
        </span>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis
          dataKey="time"
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={{ stroke: gridColor }}
          axisLine={{ stroke: gridColor }}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={{ stroke: gridColor }}
          axisLine={{ stroke: gridColor }}
          tickFormatter={(value) => `${value}%`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
            borderColor: theme === 'dark' ? '#374151' : '#e5e7eb',
            borderRadius: '8px',
            fontSize: '12px',
          }}
          labelStyle={{ color: textColor }}
          formatter={(value, name) => [
            `${(value as number)?.toFixed(1) ?? 0}%`,
            String(name).charAt(0).toUpperCase() + String(name).slice(1),
          ]}
        />
        {showLegend && (
          <Legend
            wrapperStyle={{ fontSize: '12px' }}
            formatter={(value) => (
              <span style={{ color: textColor }}>
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </span>
            )}
          />
        )}
        <Line
          type="monotone"
          dataKey="cpu"
          stroke={colors.cpu}
          strokeWidth={2}
          dot={false}
          name="CPU"
        />
        <Line
          type="monotone"
          dataKey="memory"
          stroke={colors.memory}
          strokeWidth={2}
          dot={false}
          name="Memory"
        />
        <Line
          type="monotone"
          dataKey="disk"
          stroke={colors.disk}
          strokeWidth={2}
          dot={false}
          name="Disk"
        />
      </LineChart>
    </ResponsiveContainer>
  );
});

export default MetricsChart;

// Single metric chart (CPU, Memory, or Disk only)
interface SingleMetricChartProps {
  serverId: string;
  metric: 'cpu' | 'memory' | 'disk';
  color?: string;
  height?: number;
}

export const SingleMetricChart = memo(function SingleMetricChart({
  serverId,
  metric,
  color,
  height = 100,
}: SingleMetricChartProps) {
  const history = useMetricsStore((state) => state.history[serverId] ?? EMPTY_METRICS_HISTORY);
  const theme = useThemeStore((state) => state.theme);

  const data = useMemo(() => formatMetricsForChart(history), [history]);

  const defaultColors = {
    cpu: '#f59e0b',
    memory: '#3b82f6',
    disk: '#10b981',
  };

  const chartColor = color || defaultColors[metric];
  const gridColor = theme === 'dark' ? '#374151' : '#e5e7eb';
  const textColor = theme === 'dark' ? '#9ca3af' : '#6b7280';

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs"
        style={{ height }}
      >
        <span className="text-gray-400 dark:text-gray-500">
          Waiting for data...
        </span>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis dataKey="time" hide />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: textColor, fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(value) => `${value}%`}
          ticks={[0, 50, 100]}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
            borderColor: theme === 'dark' ? '#374151' : '#e5e7eb',
            borderRadius: '6px',
            fontSize: '11px',
            padding: '4px 8px',
          }}
          formatter={(value) => [`${(value as number)?.toFixed(1) ?? 0}%`]}
          labelFormatter={(label) => String(label)}
        />
        <Line
          type="monotone"
          dataKey={metric}
          stroke={chartColor}
          strokeWidth={2}
          dot={false}
          fill={chartColor}
          fillOpacity={0.1}
        />
      </LineChart>
    </ResponsiveContainer>
  );
});

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

  if (data.length < 2) {
    return <div style={{ width, height }} className="flex items-center justify-center text-[10px] text-muted">No data</div>;
  }

  // Calculate SVG path
  const max = 100;
  const min = 0;
  const range = max - min || 1;
  const points = data.map((d, i) => {
    const x = leftPadding + (i / (data.length - 1)) * chartWidth;
    const y = height - ((d.percent - min) / range) * height;
    return { x, y, percent: d.percent, raw: d.raw };
  });

  const pathD = `M ${points.map(p => `${p.x},${p.y}`).join(' L ')}`;

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;

    // Find closest point
    if (x >= leftPadding) {
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

// Aggregated chart showing all servers
interface AggregatedMetricsChartProps {
  serverIds: string[];
  metric: 'cpu' | 'memory' | 'disk';
  height?: number;
}

export const AggregatedMetricsChart = memo(function AggregatedMetricsChart({
  serverIds,
  metric,
  height = 150,
}: AggregatedMetricsChartProps) {
  const history = useMetricsStore((state) => state.history);
  const theme = useThemeStore((state) => state.theme);

  const data = useMemo(() => {
    // Get the most recent timestamps across all servers
    const allTimestamps = new Set<number>();
    serverIds.forEach((id) => {
      (history[id] || []).forEach((point) => {
        allTimestamps.add(point.timestamp);
      });
    });

    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

    return sortedTimestamps.map((timestamp) => {
      const point: Record<string, unknown> = {
        time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      serverIds.forEach((id) => {
        const serverHistory = history[id] || [];
        const match = serverHistory.find((p) => p.timestamp === timestamp);
        if (match) {
          if (metric === 'cpu') point[id] = match.cpu;
          else if (metric === 'memory') point[id] = match.memoryPercent;
          else point[id] = match.diskPercent;
        }
      });

      return point;
    });
  }, [history, serverIds, metric]);

  const gridColor = theme === 'dark' ? '#374151' : '#e5e7eb';
  const textColor = theme === 'dark' ? '#9ca3af' : '#6b7280';

  // Generate colors for each server
  const serverColors = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899'];

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm"
        style={{ height }}
      >
        <span className="text-gray-400 dark:text-gray-500">
          Waiting for metrics...
        </span>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis
          dataKey="time"
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={{ stroke: gridColor }}
          axisLine={{ stroke: gridColor }}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={{ stroke: gridColor }}
          axisLine={{ stroke: gridColor }}
          tickFormatter={(value) => `${value}%`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
            borderColor: theme === 'dark' ? '#374151' : '#e5e7eb',
            borderRadius: '8px',
            fontSize: '12px',
          }}
          labelStyle={{ color: textColor }}
          formatter={(value, name) => [`${(value as number)?.toFixed(1) ?? 0}%`, String(name)]}
        />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        {serverIds.map((id, index) => (
          <Line
            key={id}
            type="monotone"
            dataKey={id}
            stroke={serverColors[index % serverColors.length]}
            strokeWidth={2}
            dot={false}
            name={id}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
});
