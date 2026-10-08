import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from './ui/dialog';
import Fi from './Fi';

interface NaveModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Fi icon name for the header. */
  icon?: string;
  children: ReactNode;
  maxWidth?: number | string;
  /** Hide the default close button (e.g. forced flows). */
  hideClose?: boolean;
}

/**
 * Shared modal chrome — shadcn Dialog with Nave inline-style header/footer patterns.
 */
export default function NaveModal({
  open,
  onClose,
  title,
  icon,
  children,
  maxWidth = 460,
  hideClose = false,
}: NaveModalProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        className="gap-0 p-0 overflow-hidden sm:rounded-2xl [&>button]:hidden"
        style={{
          maxWidth,
          backgroundColor: 'hsl(var(--surface-0))',
          borderColor: 'hsl(var(--border))',
        }}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={() => onClose()}
      >
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            {icon && (
              <Fi icon={icon} style={{ fontSize: '15px', color: 'hsl(var(--foreground))', flexShrink: 0 }} />
            )}
            <DialogTitle
              className="text-display font-semibold truncate"
              style={{ fontSize: '15px', color: 'hsl(var(--foreground))', margin: 0 }}
            >
              {title}
            </DialogTitle>
          </div>
          {!hideClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg transition-colors flex-shrink-0"
              style={{ color: 'hsl(var(--muted-foreground))' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              aria-label="Close"
            >
              <Fi icon="xmark" style={{ fontSize: '15px' }} />
            </button>
          )}
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}
