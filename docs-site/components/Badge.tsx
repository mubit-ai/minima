import type { ReactNode } from 'react'

// Small inline pill. Replaces Starlight's <Badge text=… variant=… />, which
// Vocs has no built-in equivalent for. Accepts either a `text` prop (Starlight
// style) or children. Colors echo the Note callout palette so the two feel
// related.
type Variant = 'default' | 'note' | 'tip' | 'success' | 'caution' | 'danger'

const STYLES: Record<Variant, { bg: string; fg: string; border: string }> = {
  default: { bg: 'rgba(154, 154, 159, 0.14)', fg: '#c6c5be', border: 'rgba(154, 154, 159, 0.4)' },
  note:    { bg: 'rgba(96, 165, 250, 0.14)',  fg: '#93c5fd', border: 'rgba(96, 165, 250, 0.45)' },
  tip:     { bg: 'rgba(74, 222, 128, 0.14)',  fg: '#86efac', border: 'rgba(74, 222, 128, 0.45)' },
  success: { bg: 'rgba(74, 222, 128, 0.14)',  fg: '#86efac', border: 'rgba(74, 222, 128, 0.45)' },
  caution: { bg: 'rgba(251, 191, 36, 0.14)',  fg: '#fcd34d', border: 'rgba(251, 191, 36, 0.45)' },
  danger:  { bg: 'rgba(248, 113, 113, 0.14)', fg: '#fca5a5', border: 'rgba(248, 113, 113, 0.45)' },
}

export function Badge({
  text,
  variant = 'default',
  children,
}: {
  text?: string
  variant?: Variant
  children?: ReactNode
}) {
  const s = STYLES[variant] ?? STYLES.default
  return (
    <span
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        marginLeft: '0.4rem',
        padding: '0.1rem 0.5rem',
        fontSize: '0.7rem',
        fontWeight: 600,
        lineHeight: 1.4,
        letterSpacing: '0.02em',
        borderRadius: '9999px',
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {text ?? children}
    </span>
  )
}
