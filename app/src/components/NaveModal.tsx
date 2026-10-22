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
  /** Optional subtitle below the title. */
  subtitle?: ReactNode;
  /** Fi icon name for the header (preserved for backward compatibility). */
  icon?: string;
  children: ReactNode;
  maxWidth?: number | string;
  /** Hide the default close button (e.g. forced flows). */
  hideClose?: boolean;
}

/**
 * Shared modal chrome matching demo.html (.modal / .modal-head / .modal-x).
 * Borderless white header, Instrument Serif 23px title, circular paper close button, 18px radius.
 */
export default function NaveModal({
  open,
  onClose,
  title,
  subtitle,
  icon: _icon,
  children,
  maxWidth = 520,
  hideClose = false,
}: NaveModalProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        className="gap-0 p-0 overflow-hidden rounded-[18px] sm:rounded-[18px] [&>button]:hidden"
        style={{
          maxWidth,
          maxHeight: '86vh',
          backgroundColor: '#ffffff',
          borderColor: 'hsl(var(--border))',
          boxShadow: '0 24px 70px -12px rgba(17, 24, 39, 0.35)',
        }}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={() => onClose()}
      >
        <div
          className="flex items-start gap-3.5"
          style={{
            padding: '20px 22px 0',
            backgroundColor: '#ffffff',
          }}
        >
          <div className="flex-1 min-w-0">
            <DialogTitle
              className="text-display"
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 400,
                fontSize: '23px',
                letterSpacing: '-0.02em',
                lineHeight: 1.15,
                color: 'hsl(var(--foreground))',
                margin: 0,
              }}
            >
              {title}
            </DialogTitle>
            {subtitle && (
              <div
                style={{
                  fontSize: '13px',
                  color: 'hsl(var(--muted-foreground))',
                  marginTop: '4px',
                  lineHeight: 1.5,
                }}
              >
                {subtitle}
              </div>
            )}
          </div>
          {!hideClose && (
            <button
              type="button"
              onClick={onClose}
              className="ml-auto flex items-center justify-center flex-shrink-0 transition-colors"
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                backgroundColor: 'hsl(var(--background))',
                border: '1px solid hsl(var(--surface-2))',
                color: 'hsl(var(--muted-foreground))',
                fontSize: '14px',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.color = 'hsl(var(--foreground))';
                e.currentTarget.style.borderColor = 'hsl(var(--border))';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
                e.currentTarget.style.borderColor = 'hsl(var(--surface-2))';
              }}
              aria-label="Close"
            >
              <Fi icon="xmark" style={{ fontSize: '14px' }} />
            </button>
          )}
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(86vh - 64px)' }}>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
