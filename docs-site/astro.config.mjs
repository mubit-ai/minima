import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Minima',
      description:
        'A recommendation engine for LLM model routing. Cuts token spend without losing quality.',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: false,
      },
      customCss: ['./src/styles/custom.css'],
      favicon: '/favicon.svg',
      head: [
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: 'https://minima.sh/og.png' },
        },
      ],
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'Getting Started', slug: 'getting-started' },
            { label: 'Concepts', slug: 'concepts' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'API Reference', slug: 'api-reference' },
            { label: 'Python Client SDK', slug: 'client-sdk' },
          ],
        },
        {
          label: 'Guides',
          items: [{ label: 'Examples', slug: 'examples' }],
        },
      ],
    }),
  ],
});
