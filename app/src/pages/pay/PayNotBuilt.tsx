import NaveEmptyState from '../../components/NaveEmptyState';

export default function PayNotBuilt({ title }: { title: string }) {
  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 400,
          fontSize: '34px',
          lineHeight: 1.1,
          letterSpacing: '-0.02em',
          margin: '0 0 18px',
          color: '#111827',
        }}
      >
        {title}
      </h1>
      <NaveEmptyState
        icon="file-lines"
        title={`${title} is not built yet`}
        description="This books module is not in the app yet. There is no data here to review."
      />
    </div>
  );
}
