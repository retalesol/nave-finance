import { useEffect, useState, type FormEvent } from 'react';
import NaveMark from '../../components/NaveMark';
import {
  clearCompassSession,
  compassRequest,
  explainCompassError,
  loadCompassSession,
  storeCompassSession,
  type CompassSession,
} from '../../lib/compass/api';
import { formatWhen } from '../../lib/compass/format';
import { AuditPanel, HappeningsPanel, OverviewPanel, TreasuriesPanel } from './CompassPanels';
import {
  Muted,
  Notice,
  buttonStyle,
  cardStyle,
  inputStyle,
  labelStyle,
  pageStyle,
  quietButtonStyle,
  sectionTitleStyle,
  wrapStyle,
} from './compassUi';

type Section = 'overview' | 'treasuries' | 'happenings' | 'audit';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'treasuries', label: 'Treasuries' },
  { id: 'happenings', label: 'Happenings' },
  { id: 'audit', label: 'Audit' },
];

export default function CompassPage() {
  const [session, setSession] = useState<CompassSession | null>(() => loadCompassSession());
  const [section, setSection] = useState<Section>('overview');
  const [treasuryId, setTreasuryId] = useState<string | null>(null);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Compass · Nave';
    let meta = document.querySelector('meta[name="robots"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'robots');
      document.head.appendChild(meta);
    }
    const previousContent = meta.getAttribute('content');
    meta.setAttribute('content', 'noindex, nofollow, noarchive');
    return () => {
      document.title = previousTitle;
      if (created) meta?.remove();
      else if (previousContent == null) meta?.removeAttribute('content');
      else meta?.setAttribute('content', previousContent);
    };
  }, []);

  function openTreasury(id: string) {
    setTreasuryId(id);
    setSection('treasuries');
  }

  async function logout() {
    const current = session;
    setSession(null);
    clearCompassSession();
    if (current) {
      try {
        await compassRequest(current, 'logout');
      } catch {
        // The local session is already gone. The server copy expires on its own.
      }
    }
  }

  return (
    <main style={pageStyle}>
      <style>{`
        .compass-input:focus-visible,
        .compass-button:focus-visible {
          outline: 2px solid hsl(var(--foreground));
          outline-offset: 2px;
        }
      `}</style>
      {session ? (
        <Console
          session={session}
          section={section}
          treasuryId={treasuryId}
          onSection={setSection}
          onOpenTreasury={openTreasury}
          onSelectTreasury={setTreasuryId}
          onLogout={() => void logout()}
          onUnauthorized={() => {
            setSession(null);
            clearCompassSession();
          }}
        />
      ) : (
        <Login onSuccess={setSession} />
      )}
    </main>
  );
}

function Login({ onSuccess }: { onSuccess: (session: CompassSession) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      const result = await compassRequest<{ token?: string; expires_at?: string }>(null, 'login', {
        username,
        password,
      });
      if (!result.token || !result.expires_at) throw new Error('bad_response');
      const next = { token: result.token, expiresAt: result.expires_at };
      storeCompassSession(next);
      setPassword('');
      onSuccess(next);
    } catch (err) {
      setError(explainCompassError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ ...wrapStyle, minHeight: '100vh', display: 'grid', alignContent: 'center', maxWidth: '440px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
        <NaveMark className="h-7 w-auto" />
        <span style={{ fontFamily: 'var(--font-display)', fontSize: '28px' }}>Compass</span>
      </div>
      <form onSubmit={(event) => void submit(event)} style={{ ...cardStyle, padding: '22px', display: 'grid', gap: '14px' }}>
        <div>
          <h1 style={{ ...sectionTitleStyle(), fontSize: '26px' }}>Operator sign-in</h1>
          <Muted>Treasuries, Nave Pay, and platform activity. This page is not linked from the product.</Muted>
        </div>
        <label style={labelStyle}>
          Username
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            style={{ ...inputStyle, marginTop: '6px' }}
            className="compass-input"
          />
        </label>
        <label style={labelStyle}>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            style={{ ...inputStyle, marginTop: '6px' }}
            className="compass-input"
          />
        </label>
        <button type="submit" disabled={pending} className="compass-button" style={{ ...buttonStyle, opacity: pending ? 0.6 : 1 }}>
          {pending ? 'Checking' : 'Sign in'}
        </button>
        {error ? <Notice>{error}</Notice> : null}
      </form>
      <p style={{ margin: '14px 0 0', color: 'hsl(var(--muted-foreground))', fontSize: '12px', lineHeight: 1.5 }}>
        Sessions last eight hours, stay in this tab, and can be signed out. Payroll, bank connections, customer documents, and signing keys are not part of this console.
      </p>
    </div>
  );
}

function Console({
  session,
  section,
  treasuryId,
  onSection,
  onOpenTreasury,
  onSelectTreasury,
  onLogout,
  onUnauthorized,
}: {
  session: CompassSession;
  section: Section;
  treasuryId: string | null;
  onSection: (section: Section) => void;
  onOpenTreasury: (id: string) => void;
  onSelectTreasury: (id: string) => void;
  onLogout: () => void;
  onUnauthorized: () => void;
}) {
  return (
    <div style={wrapStyle}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-end', marginBottom: '22px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <NaveMark className="h-6 w-auto" />
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '28px', lineHeight: 1 }}>Compass</div>
            <div style={{ color: 'hsl(var(--muted-foreground))', fontSize: '12px', marginTop: '4px' }}>
              Signed in until {formatWhen(session.expiresAt)}
            </div>
          </div>
        </div>
        <button type="button" onClick={onLogout} className="compass-button" style={quietButtonStyle}>
          Sign out
        </button>
      </header>
      <nav aria-label="Compass sections" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '22px' }}>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={section === item.id ? 'page' : undefined}
            onClick={() => onSection(item.id)}
            className="compass-button"
            style={section === item.id ? buttonStyle : quietButtonStyle}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {section === 'overview' ? (
        <OverviewPanel session={session} onUnauthorized={onUnauthorized} onOpenTreasury={onOpenTreasury} />
      ) : null}
      {section === 'treasuries' ? (
        <TreasuriesPanel
          session={session}
          onUnauthorized={onUnauthorized}
          selectedId={treasuryId}
          onSelect={onSelectTreasury}
        />
      ) : null}
      {section === 'happenings' ? (
        <HappeningsPanel session={session} onUnauthorized={onUnauthorized} onOpenTreasury={onOpenTreasury} />
      ) : null}
      {section === 'audit' ? (
        <AuditPanel session={session} onUnauthorized={onUnauthorized} onOpenTreasury={onOpenTreasury} />
      ) : null}
    </div>
  );
}
