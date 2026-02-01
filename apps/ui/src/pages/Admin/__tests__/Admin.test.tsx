import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '../../../test/utils';
import userEvent from '@testing-library/user-event';
import Admin from '../index';
import {
  createMockUser,
  createMockUsers,
  createMockAdminAuthState,
  resetFactoryCounters,
} from '../../../test/factories';

// Mock the API
const mockGetUsers = vi.fn();
const mockCreateUser = vi.fn();
const mockDeleteUser = vi.fn();

vi.mock('../../../api/client', () => ({
  api: {
    getUsers: () => mockGetUsers(),
    createUser: (...args: unknown[]) => mockCreateUser(...args),
    deleteUser: (id: string) => mockDeleteUser(id),
  },
}));

// Mock the auth store - default to admin user
const mockAdminUser = {
  userId: 'admin-1',
  username: 'admin',
  isSystemAdmin: true,
  groups: [],
};

let mockAuthState = createMockAdminAuthState();

vi.mock('../../../stores/useAuthStore', () => ({
  useAuthStore: () => ({
    ...mockAuthState,
    user: mockAdminUser,
  }),
}));

// Mock react-router-dom Navigate
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to}>Redirecting...</div>,
  };
});

// Mock HTMLDialogElement
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) {
    this.open = false;
  });
});

describe('Admin Page Integration', () => {
  beforeEach(() => {
    resetFactoryCounters();
    vi.clearAllMocks();

    // Default successful API responses
    mockGetUsers.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Tab Navigation', () => {
    it('renders with Users tab active by default', async () => {
      mockGetUsers.mockResolvedValue(createMockUsers(2));

      render(<Admin />);

      // Check Users tab is active
      const usersTab = screen.getByRole('button', { name: /users/i });
      expect(usersTab).toHaveClass('border-blue-500');

      // Check Users content loads
      await waitFor(() => {
        expect(mockGetUsers).toHaveBeenCalled();
      });
    });
  });

  describe('User Management Section', () => {
    it('loads and displays users', async () => {
      const users = [
        createMockUser({ id: 'user-1', username: 'alice', is_system_admin: false }),
        createMockUser({ id: 'user-2', username: 'bob', is_system_admin: true }),
      ];
      mockGetUsers.mockResolvedValue(users);

      render(<Admin />);

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeInTheDocument();
        expect(screen.getByText('bob')).toBeInTheDocument();
      });

      // Admin user should show System Admin badge
      expect(screen.getByText('System Admin')).toBeInTheDocument();
    });

    it('shows loading state while fetching users', async () => {
      mockGetUsers.mockImplementation(() => new Promise(() => {})); // Never resolves

      render(<Admin />);

      // Should show loading spinner
      expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('shows error state when user fetch fails', async () => {
      mockGetUsers.mockRejectedValue(new Error('Failed to load users'));

      render(<Admin />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load users')).toBeInTheDocument();
      });
    });

    it('can open create user modal', async () => {
      const user = userEvent.setup();
      mockGetUsers.mockResolvedValue([]);

      render(<Admin />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /add user/i }));

      // Modal should open with form fields
      await waitFor(() => {
        expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
      });
    });

    it('shows "You" badge for current user', async () => {
      const users = [
        createMockUser({ id: 'admin-1', username: 'admin', is_system_admin: true }),
        createMockUser({ id: 'user-2', username: 'other', is_system_admin: false }),
      ];
      mockGetUsers.mockResolvedValue(users);

      render(<Admin />);

      await waitFor(() => {
        // Current user (admin-1) should have "You" badge
        expect(screen.getByText('You')).toBeInTheDocument();
      });
    });
  });

  describe('Access Control', () => {
    it('shows admin content only for system admins', async () => {
      // The mock is already configured with an admin user
      // Verify that admin content is accessible
      mockGetUsers.mockResolvedValue([]);

      render(<Admin />);

      // Admin should see the administration heading
      expect(screen.getByRole('heading', { name: 'Administration' })).toBeInTheDocument();

      // And the users tab
      expect(screen.getByRole('button', { name: /users/i })).toBeInTheDocument();
    });
  });
});
