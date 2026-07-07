import type { ReactNode } from 'react'

export function Frame({
  caption,
  children,
}: {
  caption?: string
  children: ReactNode
}) {
  return (
    <figure
      style={{
        margin: '1.5rem 0',
        padding: '1rem',
        border: '1px solid var(--vocs-color_border)',
        borderRadius: '8px',
        background: 'var(--vocs-color_background2)',
        textAlign: 'center',
      }}
    >
      {children}
      {caption ? (
        <figcaption
          style={{
            marginTop: '0.6rem',
            fontSize: '0.8rem',
            color: 'var(--vocs-color_text3)',
          }}
        >
          {caption}
        </figcaption>
      ) : null}
    </figure>
  )
}
