export type SidebarItem = {
  text: string
  link?: string
  collapsed?: boolean
  items?: SidebarItem[]
}

export type SidebarGroup = {
  text: string
  collapsed?: boolean
  items: SidebarItem[]
}

// Path-keyed sidebars. Vocs picks the sidebar whose key is the longest prefix
// of the current path, so each top-nav tab (SDK / Minima CLI / API Reference)
// gets its own rail. `/` is the landing page.
export const sidebar: Record<string, SidebarGroup[]> = {
  '/': [
    {
      text: 'Minima',
      items: [
        { text: 'Overview', link: '/' },
        { text: 'SDK — Getting started', link: '/sdk/getting-started' },
        { text: 'Minima CLI — Overview', link: '/harness/overview' },
      ],
    },
  ],
  '/sdk': [
    {
      text: 'Start Here',
      items: [
        { text: 'Getting Started', link: '/sdk/getting-started' },
        { text: 'Concepts', link: '/sdk/concepts' },
      ],
    },
    {
      text: 'Reference',
      items: [{ text: 'Python Client SDK', link: '/sdk/client-sdk' }],
    },
    {
      text: 'Guides',
      items: [{ text: 'Examples', link: '/sdk/examples' }],
    },
  ],
  '/harness': [
    {
      text: 'Minima CLI',
      items: [
        { text: 'Overview', link: '/harness/overview' },
        { text: 'Installation', link: '/harness/installation' },
        { text: 'Configuration', link: '/harness/configuration' },
      ],
    },
    {
      text: 'Using the harness',
      items: [
        { text: 'Interactive TUI', link: '/harness/interactive' },
        { text: 'CLI usage', link: '/harness/cli' },
        { text: 'Tools & permissions', link: '/harness/tools' },
        { text: 'Model routing', link: '/harness/routing' },
        { text: 'Sessions', link: '/harness/sessions' },
      ],
    },
    {
      text: 'Help',
      items: [{ text: 'Troubleshooting', link: '/harness/troubleshooting' }],
    },
  ],
  '/api-reference': [
    {
      text: 'API Reference',
      items: [{ text: 'Endpoints', link: '/api-reference/endpoints' }],
    },
  ],
}

export function getSectionForPath(path: string): string | undefined {
  const normalized = path.replace(/\/+$/, '') || '/'

  const orderedKeys = [
    ...Object.keys(sidebar).filter((k) => k !== '/' && (normalized === k || normalized.startsWith(`${k}/`))),
    '/',
    ...Object.keys(sidebar).filter((k) => k !== '/' && !(normalized === k || normalized.startsWith(`${k}/`))),
  ]

  for (const key of orderedKeys) {
    for (const group of sidebar[key] ?? []) {
      for (const item of group.items) {
        if (item.link === normalized) return group.text
        if (item.items?.some((nested) => nested.link === normalized)) return group.text
      }
    }
  }
  return undefined
}
