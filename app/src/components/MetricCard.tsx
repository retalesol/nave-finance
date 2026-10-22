import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import Fi from './Fi';
import { Stat } from './calm';
import { staggerChild } from './PageTransition';

interface MetricCardProps {
  label: string;
  value: string;
  sub?: string;
  trend?: string;
  up?: boolean;
  icon?: string;
  /** Shown above the card while it is hovered or focused. */
  tooltip?: ReactNode;
}

export default function MetricCard({
  label,
  value,
  sub,
  trend,
  up,
  icon,
  tooltip,
}: MetricCardProps) {
  const caption =
    trend || sub ? (
      <span className="inline-flex items-center gap-1.5 flex-wrap">
        {trend && (
          <span
            className="inline-flex items-center gap-1"
            style={{
              fontSize: '12.5px',
              fontWeight: 500,
              color: up ? 'hsl(var(--success))' : 'hsl(var(--destructive))',
            }}
          >
            <Fi
              icon={up ? 'arrow-trend-up' : 'arrow-trend-down'}
              style={{ fontSize: '11px' }}
            />
            {trend}
          </span>
        )}
        {sub && (
          <span
            style={{
              fontSize: '12.5px',
              color:
                up === undefined
                  ? 'hsl(var(--muted-foreground))'
                  : up
                  ? 'hsl(var(--success))'
                  : 'hsl(var(--destructive))',
            }}
          >
            {sub}
          </span>
        )}
      </span>
    ) : undefined;

  return (
    <motion.div
      className="py-1"
      variants={staggerChild}
    >
      <Stat
        label={
          icon ? (
            <span className="inline-flex items-center gap-1.5">
              <span>{label}</span>
            </span>
          ) : (
            label
          )
        }
        value={value}
        caption={caption}
        tooltip={tooltip}
      />
    </motion.div>
  );
}
