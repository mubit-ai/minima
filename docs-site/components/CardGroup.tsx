import type { ReactNode } from 'react'

export interface CardGroupProps {
  cols?: 1 | 2 | 3 | 4
  children: ReactNode
}

export function CardGroup({ cols = 2, children }: CardGroupProps) {
  return (
    <div
      className="vocs_CardGroup"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gap: '1rem',
        margin: '1.25rem 0',
      }}
    >
      {children}
    </div>
  )
}
