import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '../../test/utils';
import Dashboard from '../Dashboard';
import {
  createMockServer,
  createMockSystemStatus,
  createMockAdminAuthState,
  resetFactoryCounters,
} from '../../test/factories';

// Mock the API hooks
const mockUseServers = vi.fn();
const mockUseSystemStatus = vi.fn();

vi.mock('../../hooks/useApi', () => ({
  useServers: () => mockUseServers(),
  useSystemStatus: () => mockUseSystemStatus(),
}));

// Mock the auth store
const mockAuthState = createMockAdminAuthState();

vi.mock('../../stores/useAuthStore', () => ({
  useAuthStore: () => mockAuthState,
}));

// Mock the metrics store
const mockAddMetrics = vi.fn();
vi.mock('../../stores/useMetricsStore', () => ({
  useMetricsStore: (selector: (state: { addMetrics: typeof mockAddMetrics }) => unknown) =>
    selector({ addMetrics: mockAddMetrics }),
}));

// Mock HTMLDialogElement
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) {
    this.open = false;
  });
});

describe('Dashboard', () => {
  beforeEach(() => {
    resetFactoryCounters();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    mockUseServers.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });
    mockUseSystemStatus.mockReturnValue({ data: undefined });

    render(<Dashboard />);

    expect(screen.getByText('Loading servers...')).toBeInTheDocument();
  });

  it('renders server cards after data loads', async () => {
    const servers = [
      createMockServer({ id: 'core', name: 'Core Server', isCore: true }),
      createMockServer({ id: 'worker-1', name: 'Worker Node 1', host: '10.0.0.50' }),
    ];
    const status = createMockSystemStatus({ servers: { total: 2, online: 2 } });

    mockUseServers.mockReturnValue({
      data: servers,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockUseSystemStatus.mockReturnValue({ data: status });

    render(<Dashboard />);

    expect(screen.getByText('Core Server')).toBeInTheDocument();
    expect(screen.getByText('Worker Node 1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('renders error state when servers API fails', async () => {
    const refetch = vi.fn();
    mockUseServers.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Failed to connect to server'),
      refetch,
    });
    mockUseSystemStatus.mockReturnValue({ data: undefined });

    render(<Dashboard />);

    expect(screen.getByText('Failed to load servers')).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: /try again/i });
    expect(retryButton).toBeInTheDocument();
  });

  it('displays correct system status in stat cards', async () => {
    const status = createMockSystemStatus({
      status: 'ok',
      servers: { total: 5, online: 4 },
    });

    mockUseServers.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockUseSystemStatus.mockReturnValue({ data: status });

    render(<Dashboard />);

    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('of 5 online')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });

  it('shows empty state when no servers exist', async () => {
    mockUseServers.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockUseSystemStatus.mockReturnValue({ data: createMockSystemStatus() });

    render(<Dashboard />);

    expect(screen.getByText('No servers connected yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add server/i })).toBeInTheDocument();
  });

  it('displays up to 6 server cards on dashboard', async () => {
    const servers = [
      createMockServer({ name: 'Server 1' }),
      createMockServer({ name: 'Server 2' }),
      createMockServer({ name: 'Server 3' }),
      createMockServer({ name: 'Server 4' }),
      createMockServer({ name: 'Server 5' }),
      createMockServer({ name: 'Server 6' }),
      createMockServer({ name: 'Server 7' }),
    ];

    mockUseServers.mockReturnValue({
      data: servers,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockUseSystemStatus.mockReturnValue({ data: createMockSystemStatus() });

    render(<Dashboard />);

    expect(screen.getByText('Server 1')).toBeInTheDocument();
    expect(screen.getByText('Server 2')).toBeInTheDocument();
    expect(screen.getByText('Server 3')).toBeInTheDocument();
    expect(screen.getByText('Server 4')).toBeInTheDocument();
    expect(screen.getByText('Server 5')).toBeInTheDocument();
    expect(screen.getByText('Server 6')).toBeInTheDocument();
    expect(screen.queryByText('Server 7')).not.toBeInTheDocument();

    expect(screen.getByRole('link', { name: /view all/i })).toHaveAttribute('href', '/servers');
  });

  it('shows Umbrel App Store coming soon message', async () => {
    mockUseServers.mockReturnValue({
      data: [createMockServer()],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockUseSystemStatus.mockReturnValue({ data: createMockSystemStatus() });

    render(<Dashboard />);

    expect(screen.getByText('Umbrel App Store integration coming soon')).toBeInTheDocument();
    expect(screen.getByText('200+ self-hosted apps via Docker')).toBeInTheDocument();
  });
});
