/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#0a0f14',
          panel: '#111827',
          header: '#1e293b',
        },
        border: {
          DEFAULT: '#1e293b',
          subtle: '#2d3748',
        },
        text: {
          primary: '#e2e8f0',
          secondary: '#64748b',
          muted: '#475569',
        },
        accent: {
          cyan: '#06b6d4',
          green: '#10b981',
          red: '#ef4444',
        }
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'SF Mono', 'Consolas', 'monospace'],
      }
    },
  },
  plugins: [],
}
