import { Link, Navigate, useParams } from 'react-router-dom';

import DocsMarkdown from '@/components/DocsMarkdown';
import DocsSidebar, { DOCS_ENTRIES_BY_SECTION, getDocBySlug } from '@/components/DocsSidebar';

function DocsHeader({ title }: { title: string }) {
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
      <div className="mx-auto h-full w-full max-w-[1280px] px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-5">
        <div className="flex items-center gap-2 min-w-0">
          <Link
            to="/"
            className="text-display"
            style={{
              fontSize: '24px',
              color: 'hsl(var(--foreground))',
              letterSpacing: '-0.01em',
              textDecoration: 'none',
              lineHeight: 1,
            }}
          >
            Nave
          </Link>
          <span className="nave-label">/ docs</span>
          <span
            style={{
              fontSize: '13px',
              color: 'hsl(var(--muted-foreground))',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
        </div>
        <Link
          to="/docs"
          className="nave-label"
          style={{
            textDecoration: 'none',
            fontSize: '11px',
            color: 'hsl(var(--foreground))',
          }}
        >
          all docs
        </Link>
      </div>
    </header>
  );
}

function MobileNav({ currentSlug }: { currentSlug: string }) {
  return (
    <nav
      className="md:hidden nave-card"
      style={{
        padding: '12px',
        marginBottom: '18px',
      }}
    >
      <p className="nave-label" style={{ marginBottom: '10px' }}>
        Sections
      </p>
      <div className="space-y-2">
        {DOCS_ENTRIES_BY_SECTION.map(({ section, entries }) => (
          <div key={section.id}>
            <p className="nave-label" style={{ marginBottom: '6px', fontSize: '10px' }}>
              {section.title}
            </p>
            <div className="flex flex-wrap gap-2">
              {entries.map((entry) => {
                const isActive = entry.slug === currentSlug;
                return (
                  <Link
                    key={entry.slug}
                    to={`/docs/${entry.slug}`}
                    className="inline-flex"
                    style={{
                      border: `1px solid hsl(var(--border))`,
                      borderColor: isActive ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                      borderRadius: '999px',
                      padding: '4px 10px',
                      textDecoration: 'none',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '11px',
                      color: isActive ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                    }}
                  >
                    {entry.title}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );
}

export default function DocsPage() {
  const { slug } = useParams<{ slug: string }>();
  const doc = getDocBySlug(slug);

  if (!doc) {
    return <Navigate to="/docs" replace />;
  }

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'hsl(var(--background))' }}>
      <DocsHeader title={doc.title} />
      <div className="mx-auto w-full max-w-[1280px] px-4 sm:px-6 lg:px-8" style={{ paddingTop: '72px', paddingBottom: '42px' }}>
        <div
          style={{
            border: '1px solid hsl(var(--border))',
            borderRadius: '12px',
            backgroundColor: 'hsl(var(--surface-0))',
            overflow: 'hidden',
          }}
        >
          <div className="hidden md:flex">
            <DocsSidebar currentSlug={doc.slug} />
            <div className="min-w-0 flex-1 px-6 lg:px-10 py-8">
              <DocsMarkdown content={doc.content} className="max-w-[720px]" />
            </div>
          </div>

          <div className="md:hidden px-4 py-5">
            <MobileNav currentSlug={doc.slug} />
            <DocsMarkdown content={doc.content} />
          </div>
        </div>
      </div>
    </div>
  );
}
