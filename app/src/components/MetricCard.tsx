import { motion } from 'framer-motion';
import Fi from './Fi';
import { staggerChild } from './PageTransition';

interface MetricCardProps {
  label: string;
  value: string;
  sub?: string;
  trend?: string;
  up?: boolean;
  icon?: string;
}

export default function MetricCard({
  label,
  value,
  sub,
  trend,
  up,
  icon,
}: MetricCardProps) {
  return (
    <motion.div className="nave-card p-5" variants={staggerChild}>
      <div className="flex items-center justify-between mb-2">
        <span className="nave-label">{label}</span>
        {icon && (
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{
              backgroundColor: 'hsl(var(--surface-1))',
              border: '1px solid hsl(var(--border))',
            }}
          >
            <Fi
              icon={icon}
              style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
            />
          </div>
        )}
      </div>
      <div
        className="text-display font-semibold"
        style={{
          fontSize: 'clamp(20px, 5vw, 26px)',
          letterSpacing: '-0.025em',
          color: 'hsl(var(--foreground))',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </div>
      {(trend || sub) && (
        <div className="flex items-center gap-1.5 mt-1">
          {trend && (
            <span
              className="flex items-center gap-1"
              style={{
                fontSize: '12px',
                color: up
                  ? 'hsl(var(--success))'
                  : 'hsl(var(--destructive))',
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
                fontSize: '12px',
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
        </div>
      )}
    </motion.div>
  );
}