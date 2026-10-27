/** Square treasury mark. Falls back to the treasury’s initial when no logo is set. */
export default function TreasuryLogo({
  url,
  name,
  size = 32,
}: {
  url?: string | null;
  name: string;
  size?: number;
}) {
  const letter = (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 1) || 'T').toUpperCase();
  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          objectFit: 'cover',
          borderRadius: 8,
          flexShrink: 0,
          border: '1px solid #E7E2D6',
          backgroundColor: '#ffffff',
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        backgroundColor: '#F4F1EA',
        border: '1px solid #E7E2D6',
        color: '#6B7280',
        fontSize: Math.max(12, Math.round(size * 0.42)),
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {letter}
    </span>
  );
}
