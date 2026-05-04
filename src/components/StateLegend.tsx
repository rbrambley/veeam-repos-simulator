import React from 'react';

export const StateLegend: React.FC = () => {
  const legendItems = [
    {
      state: 'locked',
      label: 'Locked',
      description: 'Performance immutability active',
      bgColor: '#e3f2fd',
      badgeColor: '#1565c0',
      textColor: '#1565c0',
    },
    {
      state: 'waiting',
      label: 'DeleteOn Reached',
      description: 'Waiting for tier immutability expiry',
      bgColor: '#efebe9',
      badgeColor: '#8d6e63',
      textColor: '#8d6e63',
    },
    {
      state: 'deletable',
      label: 'Deletable',
      description: 'All gates cleared; ready for removal',
      bgColor: '#e8f5e9',
      badgeColor: '#1b5e20',
      textColor: '#1b5e20',
    },
  ];

  return (
    <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', margin: '0.4rem 0 0.6rem 0', fontSize: '0.8rem' }}>
      {legendItems.map(item => (
        <div
          key={item.state}
          title={item.description}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.35rem 0.6rem',
            background: item.bgColor,
            borderRadius: '5px',
            border: `1px solid ${item.badgeColor}33`,
            cursor: 'help',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: '10px',
              height: '10px',
              borderRadius: '2px',
              background: item.badgeColor,
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: '600', color: item.textColor, whiteSpace: 'nowrap' }}>
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
};
