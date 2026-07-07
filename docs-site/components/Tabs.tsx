import { Children, isValidElement, useState, type ReactElement, type ReactNode } from 'react'

interface TabProps {
  title: string
  children: ReactNode
}

export function Tab(_: TabProps): ReactElement | null {
  // Children of <Tabs> are rendered by Tabs; this component only carries props.
  return null
}

export function Tabs({ children }: { children: ReactNode }) {
  const panels = Children.toArray(children).filter(
    (c): c is ReactElement<TabProps> =>
      isValidElement(c) && typeof (c.props as TabProps)?.title === 'string',
  )
  const [active, setActive] = useState(0)
  if (panels.length === 0) return null
  return (
    <div
      className="vocs_Tabs"
      style={{
        margin: '1rem 0',
        border: '1px solid var(--vocs-color_border)',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    >
      <div
        role="tablist"
        style={{
          display: 'flex',
          gap: '2px',
          padding: '0.25rem 0.4rem',
          background: 'var(--vocs-color_background2)',
          borderBottom: '1px solid var(--vocs-color_border)',
          overflowX: 'auto',
        }}
      >
        {panels.map((p, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={active === i}
            onClick={() => setActive(i)}
            style={{
              appearance: 'none',
              border: 'none',
              background: active === i ? 'var(--vocs-color_background)' : 'transparent',
              color: active === i ? 'var(--vocs-color_text)' : 'var(--vocs-color_text3)',
              fontSize: '0.8rem',
              fontWeight: 500,
              padding: '0.4rem 0.75rem',
              borderRadius: '6px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {p.props.title}
          </button>
        ))}
      </div>
      <div role="tabpanel" style={{ padding: '0.75rem 1rem' }}>
        {panels[active]?.props.children}
      </div>
    </div>
  )
}
