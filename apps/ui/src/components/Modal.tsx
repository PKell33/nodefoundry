import { X } from 'lucide-react';
import { useEffect, useRef, useId } from 'react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Accessible modal component using native <dialog> element.
 * Provides automatic focus trapping, Escape key handling, and proper ARIA attributes.
 *
 * IMPORTANT: Always conditionally render this component: {isOpen && <Modal ...>}
 * The native <dialog> element combined with React StrictMode can cause
 * race conditions if the modal is always mounted in the DOM. When the Modal
 * is always rendered, the useEffect that calls showModal() may fire with
 * stale or intermediate state values during component mount/unmount cycles.
 *
 * @example
 * // CORRECT - Modal only mounts when needed
 * {showModal && (
 *   <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Example">
 *     Content here
 *   </Modal>
 * )}
 *
 * // INCORRECT - Modal always in DOM, may cause race conditions
 * <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Example">
 *   Content here
 * </Modal>
 */
export default function Modal({ isOpen, onClose, title, children, size = 'md' }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  // Handle backdrop click (clicking outside the modal content)
  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // Check if click was on the dialog backdrop (not on content)
    const rect = dialog.getBoundingClientRect();
    const clickedInsideContent =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;

    // If using ::backdrop, the click target will be the dialog element itself
    // but the coordinates will be outside the dialog's visible content
    if (e.target === dialog && !clickedInsideContent) {
      onClose();
    }
  };

  // Handle native dialog close event (triggered by Escape key or form submission)
  const handleClose = () => {
    onClose();
  };

  // Handle Escape key explicitly for better control
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault(); // Prevent default to handle manually
      onClose();
    }
  };

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={handleClose}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      aria-labelledby={titleId}
      className={`${sizeClasses[size]} w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col p-0 rounded-lg shadow-xl backdrop:bg-black/60 backdrop:backdrop-blur-sm`}
      style={{
        backgroundColor: 'var(--bg-secondary, #24283b)',
        border: '1px solid var(--border-color, #292e42)',
        color: 'inherit',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: '1px solid var(--border-color, #292e42)' }}
      >
        <h2
          id={titleId}
          className="text-lg font-semibold"
          style={{ color: 'var(--text-primary, #c0caf5)' }}
        >
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded transition-colors hover:bg-[var(--bg-tertiary)]"
          style={{ color: 'var(--text-muted, #565f89)' }}
          aria-label="Close dialog"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">{children}</div>
    </dialog>
  );
}
