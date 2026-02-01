export type AuthView = 'login' | 'setup';

export interface AuthNavigateProps {
  onNavigate: (view: AuthView) => void;
  onSuccess: () => void;
}

// Tokyo Night color palette for consistent styling
export const authStyles = {
  card: {
    background: 'rgba(26, 27, 38, 0.8)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    borderRadius: '20px',
    border: '1px solid rgba(122, 162, 247, 0.2)',
    padding: '48px',
    maxWidth: '400px',
    width: '100%',
  },
  input: {
    background: 'rgba(15, 15, 23, 0.6)',
    border: '1px solid #292e42',
    borderRadius: '10px',
    color: '#c0caf5',
    padding: '12px 16px',
    paddingLeft: '44px',
    width: '100%',
    fontSize: '14px',
    outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  },
  inputFocus: {
    borderColor: '#7aa2f7',
    boxShadow: '0 0 0 2px rgba(122, 162, 247, 0.2)',
  },
  button: {
    background: 'linear-gradient(135deg, #7aa2f7 0%, #5a82d4 100%)',
    color: '#fff',
    border: 'none',
    borderRadius: '10px',
    padding: '14px 24px',
    fontSize: '15px',
    fontWeight: 600,
    cursor: 'pointer',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    transition: 'transform 0.2s, box-shadow 0.2s',
  },
  buttonHover: {
    transform: 'translateY(-1px)',
    boxShadow: '0 4px 20px rgba(122, 162, 247, 0.4)',
  },
  buttonDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
    transform: 'none',
  },
} as const;
