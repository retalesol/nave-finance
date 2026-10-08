/**
 * Fi — Font Awesome 7 Chisel icon renderer
 *
 * Usage:  <Fi icon="shield" />
 *         <Fi icon="arrow-right" className="ml-1" style={{ fontSize: '12px' }} />
 *
 * Renders:  <i class="fa-chisel fa-regular fa-{icon} {className}" style={style} />
 *
 * The FA7 kit is loaded globally via the <script> tag in index.html.
 * All icons use the Chisel style (fa-chisel fa-regular).
 */

interface FiProps {
  icon: string;
  className?: string;
  style?: React.CSSProperties;
  'aria-hidden'?: boolean;
  title?: string;
}

export default function Fi({
  icon,
  className = '',
  style,
  'aria-hidden': ariaHidden = true,
  title,
}: FiProps) {
  return (
    <i
      className={`fa-chisel fa-regular fa-${icon}${className ? ` ${className}` : ''}`}
      style={style}
      aria-hidden={ariaHidden}
      title={title}
    />
  );
}
