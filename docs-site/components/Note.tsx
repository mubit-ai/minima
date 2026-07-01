import type { ReactNode } from 'react'

type CalloutType = 'note' | 'warning' | 'tip'

const STYLES: Record<CalloutType, { bg: string; border: string; label: string; emoji: string }> = {
  note:    { bg: 'rgba(96, 165, 250, 0.08)', border: 'rgba(96, 165, 250, 0.4)', label: 'Note',    emoji: 'ℹ️' },
  warning: { bg: 'rgba(251, 191, 36, 0.08)', border: 'rgba(251, 191, 36, 0.4)', label: 'Warning', emoji: '⚠️' },
  tip:     { bg: 'rgba(74, 222, 128, 0.08)', border: 'rgba(74, 222, 128, 0.4)', label: 'Tip',     emoji: '💡' },
}

function Callout({ type, children }: { type: CalloutType; children: ReactNode }) {
  const s = STYLES[type]
  return (
    <div
      style={{
        backgroundColor: s.bg,
        borderLeft: `3px solid ${s.border}`,
        padding: '0.75rem 1rem',
        borderRadius: '0 6px 6px 0',
        margin: '1rem 0',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
        <span style={{ marginRight: '0.5rem' }}>{s.emoji}</span>{s.label}
      </div>
      <div>{children}</div>
    </div>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return <Callout type="note">{children}</Callout>
}

export function Warning({ children }: { children: ReactNode }) {
  return <Callout type="warning">{children}</Callout>
}

export function Tip({ children }: { children: ReactNode }) {
  return <Callout type="tip">{children}</Callout>
}
