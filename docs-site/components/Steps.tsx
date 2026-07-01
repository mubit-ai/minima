import { Children, isValidElement, type ReactNode } from 'react'

export function Steps({ children }: { children: ReactNode }) {
  const steps = Children.toArray(children).filter(isValidElement)
  return (
    <ol
      style={{
        listStyle: 'none',
        counterReset: 'mubit-step',
        padding: 0,
        margin: '1.25rem 0',
      }}
    >
      {steps.map((node, i) => (
        <li
          key={i}
          style={{
            counterIncrement: 'mubit-step',
            position: 'relative',
            paddingLeft: '2.4rem',
            marginBottom: '1.1rem',
          }}
        >
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: '1.7rem',
              height: '1.7rem',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.78rem',
              fontWeight: 700,
              color: '#ff4500',
              border: '1px solid var(--vocs-color_border)',
              borderRadius: '50%',
              background: 'var(--vocs-color_background2)',
            }}
          >
            {i + 1}
          </span>
          {node}
        </li>
      ))}
    </ol>
  )
}

export function Step({
  title,
  children,
}: {
  title?: string
  children: ReactNode
}) {
  return (
    <div>
      {title ? (
        <div
          style={{
            fontWeight: 600,
            fontSize: '1rem',
            marginBottom: '0.4rem',
            color: 'var(--vocs-color_text)',
          }}
        >
          {title}
        </div>
      ) : null}
      <div style={{ color: 'var(--vocs-color_text2)' }}>{children}</div>
    </div>
  )
}
