import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Fi from './Fi';
import { useDaoContext } from '../hooks/useDaoContext';
import { useNotifications, type NotificationItem, type NotificationKind } from '../hooks/useNotifications';

const KIND_META: Record<NotificationKind, { icon: string; color: string }> = {
  vote: { icon: 'check-to-slot', color: 'hsl(var(--primary))' },
  proposal: { icon: 'gavel', color: 'hsl(var(--accent))' },
  deposit: { icon: 'coins', color: 'hsl(152 50% 35%)' },
  activity: { icon: 'bolt', color: 'hsl(214 80% 48%)' },
};

function NotificationRow({ item, onNavigate }: { item: NotificationItem; onNavigate: () => void }) {
  const meta = KIND_META[item.kind];
  const content = (
    <div
      className="flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors text-left w-full"
      style={{
        backgroundColor: item.unread ? 'hsl(var(--surface-1))' : 'transparent',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = item.unread ? 'hsl(var(--surface-1))' : 'transparent';
      }}
    >
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: 'hsl(var(--surface-2))' }}
      >
        <Fi icon={meta.icon} style={{ fontSize: '12px', color: meta.color }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="font-medium truncate"
            style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}
          >
            {item.title}
          </span>
          {item.unread && (
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: 'hsl(var(--primary))' }}
            />
          )}
        </div>
        <p
          className="truncate"
          style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}
        >
          {item.body}
        </p>
        <span
          className="nave-mono"
          style={{ fontSize: '10px', color: 'hsl(var(--muted-foreground))', marginTop: '4px', display: 'block' }}
        >
          {item.time}
        </span>
      </div>
    </div>
  );

  if (item.href) {
    return (
      <Link to={item.href} className="no-underline block" onClick={onNavigate}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" className="block w-full border-0 bg-transparent p-0 cursor-pointer" onClick={onNavigate}>
      {content}
    </button>
  );
}

export default function NotificationFeed() {
  const { daoAddress } = useDaoContext();
  const navigate = useNavigate();
  const { notifications, unreadCount, loading, markAllSeen } = useNotifications(daoAddress);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  function handleOpen() {
    const next = !open;
    setOpen(next);
    if (next) markAllSeen();
  }

  function handleNavigate() {
    setOpen(false);
    markAllSeen();
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={handleOpen}
        className="relative flex items-center justify-center w-8 h-8 rounded-md border transition-colors"
        style={{
          borderColor: 'hsl(var(--border))',
          backgroundColor: open ? 'hsl(var(--surface-2))' : 'hsl(var(--surface-1))',
          color: 'hsl(var(--muted-foreground))',
        }}
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
      >
        <Fi icon="bell" style={{ fontSize: '14px' }} />
        {unreadCount > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center"
            style={{
              fontSize: '9px',
              fontFamily: 'var(--font-mono)',
              backgroundColor: 'hsl(var(--primary))',
              color: 'hsl(var(--primary-foreground))',
            }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-80 rounded-xl border shadow-lg z-50 overflow-hidden"
          style={{
            backgroundColor: 'hsl(var(--surface-0))',
            borderColor: 'hsl(var(--border))',
            boxShadow: 'var(--shadow-xl)',
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-3 border-b"
            style={{ borderColor: 'hsl(var(--border))' }}
          >
            <span className="text-display font-semibold" style={{ fontSize: '13.5px' }}>
              Notifications
            </span>
            {notifications.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  markAllSeen();
                  setOpen(false);
                }}
                style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}
                className="bg-transparent border-0 cursor-pointer"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto p-2">
            {!daoAddress ? (
              <div className="px-3 py-8 text-center" style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
                Select a treasury to see updates.
              </div>
            ) : loading && notifications.length === 0 ? (
              <div className="px-3 py-8 text-center" style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
                Loading…
              </div>
            ) : notifications.length === 0 ? (
              <div className="px-3 py-8 text-center" style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
                <Fi icon="bell-slash" style={{ fontSize: '20px', opacity: 0.4, marginBottom: '8px', display: 'block', margin: '0 auto 8px' }} />
                No recent updates
              </div>
            ) : (
              notifications.map((item) => (
                <NotificationRow key={item.id} item={item} onNavigate={handleNavigate} />
              ))
            )}
          </div>

          {daoAddress && (
            <div
              className="border-t px-3 py-2"
              style={{ borderColor: 'hsl(var(--border))' }}
            >
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate('/governance');
                }}
                className="w-full py-2 rounded-lg transition-colors"
                style={{ fontSize: '12px', color: 'hsl(var(--foreground))', backgroundColor: 'hsl(var(--surface-1))' }}
              >
                View all governance
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
