import type { ReactNode } from 'react'

export function Accordion({
  title,
  children,
  defaultOpen = false,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  return (
    <details
      open={defaultOpen}
      style={{
        margin: '1rem 0',
        padding: '0.65rem 0.9rem',
        border: '1px solid var(--vocs-color_border)',
        borderRadius: '8px',
        background: 'var(--vocs-color_background2)',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontWeight: 600,
          color: 'var(--vocs-color_text)',
          userSelect: 'none',
        }}
      >
        {title}
      </summary>
      <div style={{ marginTop: '0.6rem', color: 'var(--vocs-color_text2)' }}>
        {children}
      </div>
    </details>
  )
}
