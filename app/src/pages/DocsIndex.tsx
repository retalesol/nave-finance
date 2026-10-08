import { Link, useNavigate } from 'react-router-dom';

import Fi from '@/components/Fi';
import { DOCS_ENTRIES_BY_SECTION, DOCS_ENTRIES } from '@/components/DocsSidebar';

function DocsTopBar() {
  return (
    <header
      className="fixed top-0 inset-x-0 z-40"
      style={{
        height: '56px',
        borderBottom: '1px solid hsl(var(--border))',
        backgroundColor: 'hsla(0, 0%, 100%, 0.9)',
        backdropFilter: 'blur(10px)',
      }}
    >
      <div className="mx-auto h-full w-full max-w-[1200px] px-4 sm:px-6 lg:px-8 flex items-center justify-between">
        <Link
          to="/"
          className="text-display"
          style={{
            fontSize: '26px',
            color: 'hsl(var(--foreground))',
            letterSpacing: '-0.01em',
            textDecoration: 'none',
          }}
        >
          Nave
        </Link>
        <span
          className="nave-label"
          style={{
            fontSize: '11px',
          }}
        >
          documentation
        </span>
      </div>
    </header>
  );
}

export default function DocsIndex() {
  const navigate = useNavigate();

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'hsl(var(--background))' }}>
      <DocsTopBar />

      <main className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8" style={{ paddingTop: '112px', paddingBottom: '70px' }}>
        <section style={{ marginBottom: '42px' }}>
          <p className="nave-label" style={{ marginBottom: '10px' }}>
            Nave Documentation Portal
          </p>
          <h1
            className="text-display hero-h1"
            style={{
              fontSize: 'clamp(38px, 7vw, 64px)',
              lineHeight: 1.04,
              letterSpacing: '-0.02em',
              color: 'hsl(var(--foreground))',
              marginBottom: '12px',
            }}
          >
            Documentation
          </h1>
          <p
            style={{
              maxWidth: '780px',
              fontFamily: 'var(--font-display)',
              fontStyle: 'italic',
              fontSize: 'clamp(20px, 3vw, 28px)',
              lineHeight: 1.25,
              color: 'hsl(var(--muted-foreground))',
            }}
          >
            Technical reference for operators, developers, and partners.
          </p>
          <div className="flex items-center gap-3 mt-6">
            <button
              type="button"
              className="nave-card nave-card-hover"
              onClick={() => navigate('/docs/introduction')}
              style={{
                padding: '8px 14px',
                fontFamily: 'var(--font-mono)',
                fontSize: '11.5px',
                letterSpacing: '0.03em',
                textTransform: 'uppercase',
                color: 'hsl(var(--foreground))',
              }}
            >
              Start with introduction
            </button>
            <p className="nave-label" style={{ margin: 0 }}>
              {DOCS_ENTRIES.length} documents
            </p>
          </div>
        </section>

        <section
          className="grid gap-4 md:grid-cols-2"
          style={{
            alignItems: 'stretch',
          }}
        >
          {DOCS_ENTRIES_BY_SECTION.map(({ section, entries }) => {
            const firstEntry = entries[0];
            if (!firstEntry) {
              return null;
            }

            return (
              <Link
                key={section.id}
                to={`/docs/${firstEntry.slug}`}
                className="nave-card nave-card-hover block"
                style={{
                  textDecoration: 'none',
                  color: 'inherit',
                  padding: '18px 18px 16px',
                  minHeight: '176px',
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="nave-label" style={{ marginBottom: '10px' }}>
                      {section.title}
                    </p>
                    <h2
                      className="text-display"
                      style={{
                        fontSize: '31px',
                        lineHeight: 1.1,
                        marginBottom: '8px',
                        color: 'hsl(var(--foreground))',
                      }}
                    >
                      {firstEntry.title}
                    </h2>
                    <p
                      style={{
                        margin: 0,
                        fontSize: '14px',
                        lineHeight: 1.6,
                        color: 'hsl(var(--muted-foreground))',
                        maxWidth: '420px',
                      }}
                    >
                      {section.description}
                    </p>
                  </div>
                  <Fi
                    icon={section.icon}
                    style={{
                      fontSize: '18px',
                      color: 'hsl(var(--muted-foreground))',
                      marginTop: '2px',
                    }}
                  />
                </div>

                <div className="mt-6 flex items-center justify-between">
                  <span
                    className="nave-label"
                    style={{
                      fontSize: '11px',
                      color: 'hsl(var(--muted-foreground))',
                    }}
                  >
                    {entries.length} doc{entries.length > 1 ? 's' : ''}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '12px',
                      color: 'hsl(var(--foreground))',
                    }}
                  >
                    read
                    <Fi icon="arrow-right" className="ml-1" style={{ fontSize: '11px' }} />
                  </span>
                </div>
              </Link>
            );
          })}
        </section>
      </main>
    </div>
  );
}
