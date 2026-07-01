import { useLocation } from 'react-router'

import { getSectionForPath } from './sidebar'

const containerStyle: React.CSSProperties = {
  marginBottom: '1rem',
}

const eyebrowStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 600,
  letterSpacing: '0.08em',
  color: 'var(--vocs-color_textAccent, #ff4500)',
  textTransform: 'uppercase',
}

export function PageHeader() {
  const { pathname } = useLocation()
  const section = getSectionForPath(pathname)

  if (!section) return null

  return (
    <header style={containerStyle}>
      <div style={eyebrowStyle}>{section}</div>
    </header>
  )
}
