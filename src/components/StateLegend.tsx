import React from 'react';

export const StateLegend: React.FC = () => {
  const legendItems = [
    {
      state: 'locked',
      label: 'Locked',
      description: 'Performance immutability active; cannot move/delete',
      bgColor: '#e3f2fd',
      badgeColor: '#1565c0',
      textColor: '#1565c0',
    },
    {
      state: 'waiting',
      label: 'DeleteOn Reached',
      description: 'Retention age met, waiting for tier immutability expiry',
      bgColor: '#efebe9',
      badgeColor: '#8d6e63',
      textColor: '#8d6e63',
    },
    {
      state: 'deletable',
      label: 'Deletable',
      description: 'All gates cleared; eligible for removal this cycle',
      bgColor: '#e8f5e9',
      badgeColor: '#1b5e20',
      textColor: '#1b5e20',
    },
  ];

  return (
    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '0.75rem 0' }}>
      {legendItems.map(item => (
        <div
          key={item.state}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.5rem 0.75rem',
            background: item.bgColor,
            borderRadius: '6px',
            border: `1px solid ${item.badgeColor}33`,
            fontSize: '0.85rem',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: '12px',
              height: '12px',
              borderRadius: '3px',
              background: item.badgeColor,
            }}
          />
          <span style={{ fontWeight: '600', color: item.textColor, marginRight: '0.25rem' }}>
            {item.label}:
          </span>
          <span style={{ color: '#555' }}>
            {item.description}
          </span>
        </div>
      ))}
    </div>
  );
};
