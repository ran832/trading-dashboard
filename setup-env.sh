#!/bin/bash
# Run this script to create the .env file

cat > .env << 'EOF'
VITE_POLYGON_API_KEY=khtgXIThJZvhPcQgCrpfTOwbS092GpIW
VITE_FMP_API_KEY=LPxxQmwZub9V6gjkRsUnGNwQQlpKakzw
EOF

echo "✓ Created .env file with API keys"
echo ""
echo "  Polygon.io  - Market data (15min delayed on free tier)"
echo "  FMP         - Float & fundamentals data"
echo ""
echo "Run: npm run dev"
