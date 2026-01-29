import { useMemo } from 'react';
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

export default function MetricsChart({ serverId, height = 200, showLegend = true }: MetricsChartProps) {
  const history = useMetricsStore((state) => state.history[serverId] || []);
  const { theme } = useThemeStore();

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
}

// Single metric chart (CPU, Memory, or Disk only)
interface SingleMetricChartProps {
  serverId: string;
  metric: 'cpu' | 'memory' | 'disk';
  color?: string;
  height?: number;
}

export function SingleMetricChart({
  serverId,
  metric,
  color,
  height = 100,
}: SingleMetricChartProps) {
  const history = useMetricsStore((state) => state.history[serverId] || []);
  const { theme } = useThemeStore();

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
}

// Aggregated chart showing all servers
interface AggregatedMetricsChartProps {
  serverIds: string[];
  metric: 'cpu' | 'memory' | 'disk';
  height?: number;
}

export function AggregatedMetricsChart({
  serverIds,
  metric,
  height = 150,
}: AggregatedMetricsChartProps) {
  const history = useMetricsStore((state) => state.history);
  const { theme } = useThemeStore();

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
}
