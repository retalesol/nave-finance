import { Link, useLocation } from 'react-router-dom';
import { useEffect } from 'react';

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error('404 Error: User attempted to access non-existent route:', location.pathname);
  }, [location.pathname]);

  return (
    <div
      className="flex min-h-screen items-center justify-center px-6"
      style={{ backgroundColor: 'hsl(var(--background))' }}
    >
      <div className="text-center max-w-md w-full space-y-4">
        <div className="nave-label">404</div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 400,
            fontSize: '34px',
            letterSpacing: '-0.02em',
            lineHeight: 1.1,
            color: 'hsl(var(--foreground))',
            margin: 0,
          }}
        >
          Page <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>not found.</em>
        </h1>
        <p style={{ fontSize: '14.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
          We couldn’t find the page you were looking for.
        </p>
        <div className="pt-2">
          <Link
            to="/"
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-[9px] font-semibold no-underline"
            style={{
              fontSize: '13.5px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
            }}
          >
            Return to Home →
          </Link>
        </div>
      </div>
    </div>
  );
};

export default NotFound;
