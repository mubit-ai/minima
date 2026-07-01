import { defineConfig } from 'vocs'
import { loadEnv } from 'vite'
import React from 'react'
import path from 'node:path'
import { sidebar } from './components/sidebar'

// vocs.config.ts runs in Node (not the browser), so `import.meta.env` is empty
// here. loadEnv reads .env / .env.local for local dev AND merges any matching
// process.env vars — which is how the key arrives during the Docker/CI build.
const env = loadEnv(process.env.NODE_ENV || 'production', process.cwd(), 'VITE_')
const POSTHOG_KEY = env.VITE_PUBLIC_POSTHOG_KEY
const POSTHOG_HOST = env.VITE_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com'

// Standard PostHog loader. Injected into <head> at build time, so the project
// API key (public by design) is baked into the static HTML. Guarded on the key
// so local builds and previews without it ship no snippet at all.
const posthogSnippet = `
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init('${POSTHOG_KEY}', {
  api_host: '${POSTHOG_HOST}',
  person_profiles: 'identified_only',
  capture_pageview: 'history_change',
  capture_pageleave: true,
  defaults: '2025-05-24'
});
`

export default defineConfig({
  vite: {
    resolve: {
      alias: {
        '@components': path.resolve('./components'),
      },
    },
  },
  title: 'Minima',
  titleTemplate: '%s · Minima',
  description:
    'A recommendation engine for LLM model routing. Cuts token spend without losing quality — plus the minima harness, a cost-aware terminal coding agent.',
  iconUrl: '/images/favicon.png',
  logoUrl: {
    light: '/images/logo-light.svg',
    dark: '/images/logo-dark.svg',
  },
  rootDir: '.',
  ogImageUrl:
    'https://vocs.dev/api/og?logo=%logo&title=%title&description=%description',
  theme: {
    accentColor: '#ff4500',
    colorScheme: 'dark',
    variables: {
      content: {
        width: '1200px',
      },
    },
  },
  font: {
    google: 'JetBrains Mono',
  },
  aiCta: false,
  search: {
    boostDocument: (_id, _term, storedFields) =>
      storedFields?.isPage ? 2 : 1,
  },
  topNav: [
    { text: 'SDK', link: '/sdk/getting-started', match: '/sdk' },
    { text: 'Minima CLI', link: '/harness/overview', match: '/harness' },
    { text: 'API Reference', link: '/api-reference/endpoints', match: '/api-reference' },
  ],
  sidebar,
  // Global <head> injection. The function form is required (not a bare element):
  // Vocs checks `typeof head === 'object'` first, and a React element is an
  // object — so a bare element gets misread as a `{ path: element }` map and
  // silently dropped. The function is called per page and its returned element
  // is injected into every <head>.
  //
  //   1. /styles/global.css — always. Styles the top-nav "Get API Key" link as
  //      a prominent CTA button (see public/styles/global.css).
  //   2. PostHog loader — only when a key is set.
  head: () => {
    const tags: React.ReactElement[] = [
      React.createElement('link', {
        rel: 'stylesheet',
        href: '/styles/global.css',
      }),
    ]
    if (POSTHOG_KEY) {
      tags.push(
        React.createElement('script', {
          dangerouslySetInnerHTML: { __html: posthogSnippet },
        }),
      )
    }
    return React.createElement(React.Fragment, null, ...tags)
  },
})
