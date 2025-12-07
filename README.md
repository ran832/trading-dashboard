# Day Trading Scanner Dashboard

A personal day trading scanner built with React, TypeScript, and Tailwind CSS. Features a dark terminal-style theme optimized for market monitoring.

## Features

- **Live Scanner Table**: Displays stock data with heatmap coloring
  - Volume/RVol: Cyan gradient (darker = lower, brighter = higher)
  - Gap%/Change%: Green for positive, red for negative
  - Auto-updates every 8 seconds with simulated price changes

- **Symbol Details Panel**: Click any row to see detailed stats
  - Large symbol display with price
  - Key metrics: Volume, Float, RVol, Gap%

- **Watchlist**: Track symbols you're interested in
  - Add/remove symbols
  - Optional notes per symbol
  - Persists to localStorage

- **Quick Notes**: Textarea for trading notes
  - Auto-saves to localStorage

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## Tech Stack

- React 18
- TypeScript
- Vite
- Tailwind CSS

## Color Scheme

| Purpose | Color |
|---------|-------|
| Background | `#0f1419` |
| Panel | `#1a2332` |
| Border | `#2d3748` |
| Text | `#e2e8f0` |
| Muted | `#94a3b8` |
| Accent | `#06b6d4` (cyan) |
| Green | `#10b981` |
| Red | `#ef4444` |

## Mock Data

Currently uses randomly generated mock data. To integrate with real APIs:

1. Replace `generateInitialData()` and `updateStockData()` in `src/utils/mockData.ts`
2. Connect to your preferred data provider (Polygon.io, Alpaca, etc.)

