import { Link } from 'react-router-dom';
import type { Crumb } from '../lib/breadcrumbs';

export default function AppBreadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="app-crumbs">
      <ol>
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`}>
              {index > 0 ? <span className="app-crumbs-sep" aria-hidden>›</span> : null}
              {crumb.to && !current ? (
                <Link to={crumb.to}>{crumb.label}</Link>
              ) : (
                <span aria-current={current ? 'page' : undefined}>{crumb.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
