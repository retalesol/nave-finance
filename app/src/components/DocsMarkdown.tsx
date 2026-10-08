import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';

interface DocsMarkdownProps {
  content: string;
  className?: string;
}

const markdownComponents: Components = {
  a: ({ node, href, children, ...props }) => {
    const target = typeof href === 'string' ? href : '';
    const isExternal = /^https?:\/\//.test(target);
    const isInternalRoute = target.startsWith('/');

    if (isInternalRoute) {
      return (
        <Link to={target} {...props}>
          {children}
        </Link>
      );
    }

    return (
      <a
        {...props}
        href={href}
        target={isExternal ? '_blank' : undefined}
        rel={isExternal ? 'noreferrer noopener' : undefined}
      >
        {children}
      </a>
    );
  },
};

export default function DocsMarkdown({ content, className = '' }: DocsMarkdownProps) {
  return (
    <article className={`docs-prose ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </article>
  );
}
