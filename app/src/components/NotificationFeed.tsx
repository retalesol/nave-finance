import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Fi from './Fi';
import { useDaoContext } from '../hooks/useDaoContext';
import { useNotifications, type NotificationItem, type NotificationKind } from '../hooks/useNotifications';

const KIND_DOT_COLOR: Record<NotificationKind, string> = {
  vote: 'hsl(var(--brass))',
  proposal: 'hsl(var(--brass))',
  deposit: 'hsl(var(--success))',
  activity: 'hsl(var(--faint))',
};

function NotificationRow({ item, onNavigate }: { item: NotificationItem; onNavigate: () => void }) {
  const dotColor = KIND_DOT_COLOR[item.kind];
  const content = (
    <div
      className="flex items-start gap-2.5 py-3 px-1 text-left w-full border-b last:border-b-0 group transition-colors"
      style={{
        borderColor: 'hsl(var(--surface-2))',
      }}
    >
      <span
        className="flex-shrink-0 rounded-full"
        style={{
          width: '8px',
          height: '8px',
          marginTop: '6px',
          backgroundColor: item.unread ? dotColor : 'hsl(var(--border))',
        }}
      />
      <div className="flex-1 min-w-0">
        <div
          className="font-medium truncate group-hover:text-brass transition-colors"
          style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}
        >
          {item.title}
        </div>
        <p
          className="truncate"
          style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}
        >
          {item.body}
        </p>
      </div>
      <span
        className="flex-shrink-0"
        style={{ fontSize: '11.5px', color: 'hsl(var(--faint))', paddingTop: '2px' }}
      >
        {item.time}
      </span>
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
        className="relative flex-shrink-0 transition-colors"
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '50%',
          border: `1px solid ${open ? '#CFC8B8' : '#E7E2D6'}`,
          backgroundColor: '#ffffff',
          color: '#111827',
          display: 'grid',
          placeItems: 'center',
          fontSize: '15px',
        }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = '#CFC8B8')}
        onMouseLeave={e => (e.currentTarget.style.borderColor = open ? '#CFC8B8' : '#E7E2D6')}
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
      >
        <Fi icon="bell" style={{ fontSize: '14px' }} />
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: '-4px',
              right: '-4px',
              backgroundColor: '#B42318',
              color: '#ffffff',
              fontSize: '9px',
              fontWeight: 700,
              minWidth: '16px',
              height: '16px',
              borderRadius: '99px',
              display: 'grid',
              placeItems: 'center',
              padding: '0 3px',
            }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-80 rounded-[18px] border z-50 overflow-hidden"
          style={{
            backgroundColor: '#ffffff',
            borderColor: 'hsl(var(--border))',
            boxShadow: 'var(--shadow-xl)',
          }}
        >
          <div
            className="flex items-center justify-between px-5 pt-4 pb-3 border-b"
            style={{ borderColor: 'hsl(var(--surface-2))' }}
          >
            <span
              className="text-display"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: '19px',
                fontWeight: 400,
                color: 'hsl(var(--foreground))',
              }}
            >
              Notifications
            </span>
            {notifications.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  markAllSeen();
                  setOpen(false);
                }}
                style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
                className="bg-transparent border-0 cursor-pointer hover:underline underline-offset-4"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto px-4 py-1">
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
              className="border-t px-4 py-2.5"
              style={{ borderColor: 'hsl(var(--surface-2))' }}
            >
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate('/decisions');
                }}
                className="w-full py-1.5 rounded-[9px] transition-colors font-medium"
                style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))', backgroundColor: 'hsl(var(--background))' }}
              >
                View all decisions
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
