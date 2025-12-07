import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { 
  fetchScannerData, 
  ProcessedStock, 
  ApiStatus, 
  matchesCriteria,
  isPreMarket,
  isMarketJustOpened,
  formatTime 
} from './api/polygon';

// Debug API keys on load
console.log('🔑 Polygon API Key:', import.meta.env.VITE_POLYGON_API_KEY ? '✓ Present' : '✗ Missing');
console.log('🔑 FMP API Key:', import.meta.env.VITE_FMP_API_KEY ? '✓ Present' : '✗ Missing');

// ============ TYPES ============
interface Stock extends ProcessedStock {}

interface WatchlistItem {
  symbol: string;
  note: string;
  addedPrice: number;
  color: 'red' | 'yellow' | 'green' | 'none';
  priceHistory: number[];
}

interface AlertItem {
  id: string;
  symbol: string;
  type: 'newMover' | 'breakout' | 'volumeSpike';
  message: string;
  time: string;
  timestamp: number;
}

interface AlertSettings {
  soundEnabled: boolean;
  flashEnabled: boolean;
  volume: number;
  changeThreshold: number;
  rvolThreshold: number;
}

type ScannerTab = 'gappers' | 'momentum' | 'highRvol';
type ChartInterval = '1' | '5' | '15' | 'D';
type SortColumn = 'time' | 'symbol' | 'price' | 'volume' | 'float' | 'rVol' | 'gapPercent' | 'changePercent' | 'vwapDistance';
type SortDirection = 'asc' | 'desc' | null;

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

// ============ MOCK DATA FALLBACK ============
const MOCK_SYMBOLS = ['NVDA', 'TSLA', 'AMD', 'META', 'AAPL', 'GOOGL', 'AMZN', 'MSFT', 'PLTR', 'SOFI', 'NIO', 'COIN', 'MARA', 'RIOT', 'GME', 'AMC', 'MULN', 'FFIE', 'GOEV', 'WKHS'];

const rand = (min: number, max: number) => Math.random() * (max - min) + min;
const randInt = (min: number, max: number) => Math.floor(rand(min, max));

const generateMockStock = (symbol: string): Stock => {
  const price = Math.round(rand(1, 50) * 100) / 100;
  const gapPercent = Math.round(rand(2, 80) * 100) / 100;
  const changePercent = Math.round(rand(-5, 50) * 100) / 100;
  const rVol = Math.round(rand(1, 25) * 100) / 100;
  const volume = randInt(500000, 80000000);
  const vwap = price * 0.98;
  const vwapDistance = ((price - vwap) / vwap) * 100;
  
  return {
    symbol,
    companyName: symbol,
    exchange: 'NASDAQ',
    price,
    prevPrice: price,
    dayHigh: price * 1.05,
    dayLow: price * 0.92,
    dayOpen: price * (1 - gapPercent / 100),
    volume,
    float: randInt(2000000, 100000000),
    marketCap: randInt(50000000, 10000000000),
    sector: '',
    rVol,
    prevRVol: rVol,
    gapPercent,
    changePercent,
    prevChangePercent: changePercent,
    vwap,
    vwapDistance: Math.round(vwapDistance * 100) / 100,
    high52w: price * 2,
    low52w: price * 0.3,
    time: formatTime(),
    strategy: gapPercent > 10 ? ['Gap & Go'] : ['Momentum'],
    prevDayClose: price * (1 - changePercent / 100),
    prevDayVolume: volume * 0.7,
    priceHistory: Array(10).fill(0).map(() => price + rand(-1, 1)),
  };
};

const generateMockData = () => {
  const stocks = MOCK_SYMBOLS.map(s => generateMockStock(s));
  return {
    gappers: [...stocks].sort((a, b) => b.gapPercent - a.gapPercent),
    momentum: [...stocks].sort((a, b) => b.changePercent - a.changePercent),
    highRvol: [...stocks].sort((a, b) => b.rVol - a.rVol),
  };
};

// ============ AUDIO SYSTEM ============
const playAlert = (type: 'newMover' | 'breakout' | 'volumeSpike', volume: number = 0.3) => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    if (type === 'newMover') osc.frequency.value = 880;
    else if (type === 'breakout') osc.frequency.value = 1100;
    else osc.frequency.value = 660;
    
    osc.type = 'sine';
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    
    if (type === 'breakout') {
      setTimeout(() => {
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.frequency.value = 1320;
        osc2.type = 'sine';
        gain2.gain.setValueAtTime(volume, ctx.currentTime);
        gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
        osc2.start();
        osc2.stop(ctx.currentTime + 0.1);
      }, 120);
    }
  } catch (e) {
    console.log('Audio not supported');
  }
};

// ============ HEATMAP COLORS ============
const getVolumeColor = (vol: number): string => {
  if (vol >= 50000000) return 'rgba(6, 182, 212, 0.7)';
  if (vol >= 20000000) return 'rgba(6, 182, 212, 0.5)';
  if (vol >= 5000000) return 'rgba(6, 182, 212, 0.3)';
  if (vol >= 1000000) return 'rgba(6, 182, 212, 0.15)';
  return 'rgba(6, 182, 212, 0.05)';
};

const getFloatColor = (float: number): string => {
  if (float <= 0) return 'transparent';
  if (float < 5000000) return 'rgba(6, 182, 212, 0.8)';
  if (float < 10000000) return 'rgba(6, 182, 212, 0.6)';
  if (float < 20000000) return 'rgba(6, 182, 212, 0.4)';
  if (float < 50000000) return 'rgba(6, 182, 212, 0.2)';
  return 'rgba(6, 182, 212, 0.1)';
};

const getRvolColor = (rvol: number): string => {
  if (rvol >= 10) return 'rgba(6, 182, 212, 0.8)';
  if (rvol >= 5) return 'rgba(6, 182, 212, 0.5)';
  if (rvol >= 2) return 'rgba(6, 182, 212, 0.3)';
  return 'rgba(6, 182, 212, 0.1)';
};

const getPercentColor = (pct: number): string => {
  if (pct >= 20) return 'rgba(16, 185, 129, 0.7)';
  if (pct >= 10) return 'rgba(16, 185, 129, 0.5)';
  if (pct >= 5) return 'rgba(16, 185, 129, 0.3)';
  if (pct >= 0) return 'rgba(16, 185, 129, 0.15)';
  if (pct >= -5) return 'rgba(239, 68, 68, 0.15)';
  if (pct >= -10) return 'rgba(239, 68, 68, 0.3)';
  return 'rgba(239, 68, 68, 0.5)';
};

const getVwapColor = (dist: number): { bg: string; text: string } => {
  if (dist >= 5) return { bg: 'rgba(239, 68, 68, 0.3)', text: '#ef4444' };
  if (dist >= 2) return { bg: 'rgba(245, 158, 11, 0.3)', text: '#f59e0b' };
  if (dist >= -2) return { bg: 'rgba(16, 185, 129, 0.4)', text: '#10b981' };
  return { bg: 'rgba(6, 182, 212, 0.3)', text: '#06b6d4' };
};

// ============ FORMATTERS ============
const formatNum = (n: number): string => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toFixed(0);
};

const formatPct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

// ============ STORAGE ============
const STORAGE = { 
  WATCHLIST: 'dtd_watchlist', 
  NOTES: 'dtd_notes', 
  ACCOUNT: 'dtd_account',
  ALERT_SETTINGS: 'dtd_alert_settings',
  MY_SETUPS: 'dtd_my_setups',
  SOUND_ENABLED: 'dtd_sound_enabled',
  SCANNER_SORT: 'dtd_scanner_sort',
};

const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  soundEnabled: true,
  flashEnabled: true,
  volume: 0.3,
  changeThreshold: 3,
  rvolThreshold: 10,
};

const DEFAULT_SORT: SortState = { column: 'gapPercent', direction: 'desc' };

// ============ MINI SPARKLINE ============
const Sparkline = ({ data, width = 60, height = 20 }: { data: number[]; width?: number; height?: number }) => {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');
  const isUp = data[data.length - 1] >= data[0];
  
  return (
    <svg width={width} height={height} className="inline-block">
      <polyline points={points} fill="none" stroke={isUp ? '#10b981' : '#ef4444'} strokeWidth="1.5" />
    </svg>
  );
};

// ============ PANEL WRAPPER ============
const Panel = ({ title, children, className = '', headerRight, preMarket }: { 
  title: string; 
  children: React.ReactNode; 
  className?: string; 
  headerRight?: React.ReactNode;
  preMarket?: boolean;
}) => (
  <div className={`bg-[#111827] border border-[#1e293b] rounded flex flex-col panel-enter ${className}`}>
    <div className={`h-7 border-b border-[#1e293b] px-2 flex items-center justify-between shrink-0 ${
      preMarket ? 'bg-gradient-to-r from-[#1e1b4b] to-[#312e81]' : 'bg-gradient-to-r from-[#0f1419] to-[#1a2332]'
    }`}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[#64748b] cursor-move">⋮⋮</span>
        <span className={`text-[11px] font-semibold uppercase tracking-wide ${preMarket ? 'text-[#8b5cf6]' : 'text-[#06b6d4]'}`}>{title}</span>
      </div>
      <div className="flex items-center gap-2">
        {headerRight}
        <span className="text-[#64748b] text-[10px] hover:text-[#ef4444] cursor-pointer">✕</span>
      </div>
    </div>
    <div className="flex-1 overflow-hidden">{children}</div>
  </div>
);

// ============ KEYBOARD SHORTCUTS MODAL ============
const ShortcutsModal = ({ onClose }: { onClose: () => void }) => (
  <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
    <div className="bg-[#111827] border border-[#1e293b] rounded-lg p-4 max-w-md" onClick={e => e.stopPropagation()}>
      <h3 className="text-[#06b6d4] font-bold mb-4">⌨️ Keyboard Shortcuts</h3>
      <div className="grid grid-cols-2 gap-2 text-[12px]">
        {[
          ['↑ / ↓', 'Navigate rows'],
          ['Enter', 'Select row'],
          ['M', 'Toggle My Setups'],
          ['S', 'Toggle Sound'],
          ['R', 'Refresh data'],
          ['1 / 2 / 3', 'Switch tabs'],
          ['W', 'Add to watchlist'],
          ['Esc', 'Deselect'],
          ['?', 'Show shortcuts'],
        ].map(([key, desc]) => (
          <div key={key} className="flex items-center gap-2">
            <kbd className="px-2 py-0.5 bg-[#1e293b] rounded text-[#06b6d4] font-mono">{key}</kbd>
            <span className="text-[#94a3b8]">{desc}</span>
          </div>
        ))}
      </div>
      <button onClick={onClose} className="mt-4 w-full py-1.5 bg-[#06b6d4]/20 text-[#06b6d4] rounded text-[11px]">Close</button>
    </div>
  </div>
);

// ============ CONTEXT MENU ============
const ContextMenu = ({ x, y, stock, onClose, onAddWatchlist, onOpenTV, onCopy }: {
  x: number; y: number; stock: Stock; onClose: () => void;
  onAddWatchlist: () => void; onOpenTV: () => void; onCopy: () => void;
}) => (
  <div className="fixed bg-[#1e293b] border border-[#374151] rounded shadow-lg py-1 z-50 text-[11px]" style={{ left: x, top: y }}>
    <button onClick={() => { onAddWatchlist(); onClose(); }} className="w-full px-3 py-1.5 text-left hover:bg-[#06b6d4]/20 text-[#e2e8f0]">➕ Add to Watchlist</button>
    <button onClick={() => { onOpenTV(); onClose(); }} className="w-full px-3 py-1.5 text-left hover:bg-[#06b6d4]/20 text-[#e2e8f0]">📈 Open in TradingView</button>
    <button onClick={() => { onCopy(); onClose(); }} className="w-full px-3 py-1.5 text-left hover:bg-[#06b6d4]/20 text-[#e2e8f0]">📋 Copy Symbol</button>
  </div>
);

// ============ SORTABLE HEADER ============
const SortableHeader = ({ 
  column, 
  label, 
  sortState, 
  onSort, 
  align = 'right' 
}: { 
  column: SortColumn; 
  label: string; 
  sortState: SortState; 
  onSort: (col: SortColumn) => void;
  align?: 'left' | 'right';
}) => {
  const isActive = sortState.column === column && sortState.direction !== null;
  const indicator = isActive ? (sortState.direction === 'desc' ? ' ▼' : ' ▲') : '';
  
  return (
    <th 
      onClick={() => onSort(column)}
      className={`px-1.5 py-1.5 font-medium cursor-pointer select-none transition-colors hover:bg-[#374151]/50 ${
        align === 'left' ? 'text-left' : 'text-right'
      } ${isActive ? 'text-[#06b6d4]' : ''}`}
    >
      {label}{indicator}
    </th>
  );
};

// ============ MAIN APP ============
function App() {
  // Core state
  const [activeTab, setActiveTab] = useState<ScannerTab>('gappers');
  const [stocks, setStocks] = useState<Record<ScannerTab, Stock[]>>(() => generateMockData());
  const [apiStatus, setApiStatus] = useState<ApiStatus>('offline');
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [selected, setSelected] = useState<Stock | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [flashMap, setFlashMap] = useState<Record<string, 'up' | 'down' | null>>({});
  const [chartInterval, setChartInterval] = useState<ChartInterval>('5');
  
  // Sorting state
  const [sortState, setSortState] = useState<SortState>(() => {
    try {
      const saved = localStorage.getItem(STORAGE.SCANNER_SORT);
      return saved ? JSON.parse(saved) : DEFAULT_SORT;
    } catch {
      return DEFAULT_SORT;
    }
  });
  
  // My Setups filter
  const [mySetupsOnly, setMySetupsOnly] = useState(() => {
    try { return localStorage.getItem(STORAGE.MY_SETUPS) === 'true'; } catch { return false; }
  });
  
  // Sound
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try { return localStorage.getItem(STORAGE.SOUND_ENABLED) !== 'false'; } catch { return true; }
  });
  
  // Watchlist
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE.WATCHLIST) || '[]'); } catch { return []; }
  });
  const [notes, setNotes] = useState(() => localStorage.getItem(STORAGE.NOTES) || '');
  const [watchInput, setWatchInput] = useState('');
  
  // Position Calculator
  const [calcOpen, setCalcOpen] = useState(true);
  const [accountSize, setAccountSize] = useState(() => {
    try { return Number(localStorage.getItem(STORAGE.ACCOUNT)) || 25000; } catch { return 25000; }
  });
  const [riskPercent, setRiskPercent] = useState(1);
  const [entryPrice, setEntryPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  
  // Alerts
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertedSymbols, setAlertedSymbols] = useState<Set<string>>(new Set());
  const [unreadAlertCount, setUnreadAlertCount] = useState(0);
  const [newMoversCount, setNewMoversCount] = useState(0);
  const [showAlertLog, setShowAlertLog] = useState(false);
  const [alertSettings] = useState<AlertSettings>(DEFAULT_ALERT_SETTINGS);
  
  // UI State
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; stock: Stock } | null>(null);
  const [currentTime, setCurrentTime] = useState(formatTime());
  
  // Refs
  const notesTimeoutRef = useRef<number>();
  const prevStocksRef = useRef<Record<ScannerTab, Stock[]> | null>(null);
  const isFirstRender = useRef(true);
  const chartRef = useRef<HTMLDivElement>(null);

  // Market status
  const preMarket = isPreMarket();
  const justOpened = isMarketJustOpened();

  // Live clock
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(formatTime()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Handle sorting
  const handleSort = useCallback((column: SortColumn) => {
    setSortState(prev => {
      let newDirection: SortDirection;
      
      if (prev.column !== column) {
        // New column, start with desc
        newDirection = 'desc';
      } else if (prev.direction === 'desc') {
        // Same column, was desc, now asc
        newDirection = 'asc';
      } else if (prev.direction === 'asc') {
        // Same column, was asc, now reset
        newDirection = null;
      } else {
        // Was null, start with desc
        newDirection = 'desc';
      }
      
      const newState = { column, direction: newDirection };
      localStorage.setItem(STORAGE.SCANNER_SORT, JSON.stringify(newState));
      return newState;
    });
  }, []);

  // Sort stocks
  const sortStocks = useCallback((stocksToSort: Stock[]): Stock[] => {
    if (sortState.direction === null) {
      return stocksToSort;
    }
    
    const sorted = [...stocksToSort].sort((a, b) => {
      let aVal: number | string;
      let bVal: number | string;
      
      switch (sortState.column) {
        case 'time':
          aVal = a.time;
          bVal = b.time;
          break;
        case 'symbol':
          aVal = a.symbol;
          bVal = b.symbol;
          break;
        case 'price':
          aVal = a.price;
          bVal = b.price;
          break;
        case 'volume':
          aVal = a.volume;
          bVal = b.volume;
          break;
        case 'float':
          aVal = a.float || 0;
          bVal = b.float || 0;
          break;
        case 'rVol':
          aVal = a.rVol;
          bVal = b.rVol;
          break;
        case 'gapPercent':
          aVal = a.gapPercent;
          bVal = b.gapPercent;
          break;
        case 'changePercent':
          aVal = a.changePercent;
          bVal = b.changePercent;
          break;
        case 'vwapDistance':
          aVal = a.vwapDistance;
          bVal = b.vwapDistance;
          break;
        default:
          return 0;
      }
      
      if (typeof aVal === 'string') {
        return sortState.direction === 'desc' 
          ? bVal.toString().localeCompare(aVal.toString())
          : aVal.toString().localeCompare(bVal.toString());
      }
      
      return sortState.direction === 'desc' ? bVal - aVal : aVal - bVal;
    });
    
    return sorted;
  }, [sortState]);

  // Filtered and sorted stocks
  const filteredStocks = useMemo(() => {
    let current = stocks[activeTab];
    if (mySetupsOnly) {
      current = current.filter(matchesCriteria);
    }
    return sortStocks(current);
  }, [stocks, activeTab, mySetupsOnly, sortStocks]);

  const matchingCount = useMemo(() => {
    return stocks[activeTab].filter(matchesCriteria).length;
  }, [stocks, activeTab]);

  // Fetch data
  const fetchData = useCallback(async () => {
    setIsLoading(true);
    console.log('📡 Fetching scanner data...');
    
    try {
      const prevData = prevStocksRef.current ? {
        gappers: prevStocksRef.current.gappers,
        momentum: prevStocksRef.current.momentum,
        highRvol: prevStocksRef.current.highRvol,
      } : undefined;
      
      const data = await fetchScannerData(prevData);
      console.log('✓ Data fetched:', data.gappers.length, 'gappers');
      
      // Track price flashes
      const allNewStocks = [...data.gappers, ...data.momentum, ...data.highRvol];
      const flashes: Record<string, 'up' | 'down' | null> = {};
      
      if (prevStocksRef.current) {
        const prevLookup = new Map<string, Stock>();
        [...prevStocksRef.current.gappers, ...prevStocksRef.current.momentum, ...prevStocksRef.current.highRvol]
          .forEach(s => prevLookup.set(s.symbol, s));
        
        allNewStocks.forEach(s => {
          const prev = prevLookup.get(s.symbol);
          if (prev) {
            if (s.price > prev.price) flashes[s.symbol] = 'up';
            else if (s.price < prev.price) flashes[s.symbol] = 'down';
          }
        });
      }
      
      setFlashMap(flashes);
      setTimeout(() => setFlashMap({}), 600);
      
      // Detect alerts
      if (!isFirstRender.current && prevStocksRef.current) {
        const newAlerts: AlertItem[] = [];
        const time = formatTime();
        const timestamp = Date.now();
        let newMovers = 0;
        
        const prevSymbols = new Set([
          ...prevStocksRef.current.gappers.map(s => s.symbol),
          ...prevStocksRef.current.momentum.map(s => s.symbol),
          ...prevStocksRef.current.highRvol.map(s => s.symbol),
        ]);
        
        allNewStocks.forEach(stock => {
          const prevStock = prevStocksRef.current?.gappers.find(s => s.symbol === stock.symbol) ||
                           prevStocksRef.current?.momentum.find(s => s.symbol === stock.symbol) ||
                           prevStocksRef.current?.highRvol.find(s => s.symbol === stock.symbol);
          
          if (!prevSymbols.has(stock.symbol) && matchesCriteria(stock)) {
            newAlerts.push({ id: `${stock.symbol}-new-${timestamp}`, symbol: stock.symbol, type: 'newMover', message: `🔥 ${stock.symbol} new to scanner`, time, timestamp });
            newMovers++;
            if (soundEnabled) playAlert('newMover', alertSettings.volume);
          }
          
          if (prevStock) {
            const changeDiff = stock.changePercent - prevStock.prevChangePercent;
            if (changeDiff > alertSettings.changeThreshold) {
              newAlerts.push({ id: `${stock.symbol}-spike-${timestamp}`, symbol: stock.symbol, type: 'breakout', message: `⚡ ${stock.symbol} +${changeDiff.toFixed(1)}% spike`, time, timestamp });
              if (soundEnabled) playAlert('breakout', alertSettings.volume);
            }
            
            if (stock.rVol >= alertSettings.rvolThreshold && prevStock.prevRVol < alertSettings.rvolThreshold) {
              newAlerts.push({ id: `${stock.symbol}-rvol-${timestamp}`, symbol: stock.symbol, type: 'volumeSpike', message: `📊 ${stock.symbol} RVol ${stock.rVol.toFixed(1)}x`, time, timestamp });
              if (soundEnabled) playAlert('volumeSpike', alertSettings.volume);
            }
          }
        });
        
        if (newAlerts.length > 0) {
          setAlerts(prev => [...newAlerts, ...prev].slice(0, 30));
          setUnreadAlertCount(prev => prev + newAlerts.length);
          setNewMoversCount(prev => prev + newMovers);
          
          const newAlertedSymbols = new Set(alertedSymbols);
          newAlerts.forEach(a => newAlertedSymbols.add(a.symbol));
          setAlertedSymbols(newAlertedSymbols);
          
          setTimeout(() => {
            setAlertedSymbols(prev => {
              const next = new Set(prev);
              newAlerts.forEach(a => next.delete(a.symbol));
              return next;
            });
          }, 30000);
        }
      }
      
      isFirstRender.current = false;
      
      setStocks({ gappers: data.gappers, momentum: data.momentum, highRvol: data.highRvol });
      prevStocksRef.current = { gappers: data.gappers, momentum: data.momentum, highRvol: data.highRvol };
      
      setApiStatus(data.status);
      setLastUpdate(formatTime());
      
      if (selected) {
        const allStocks = [...data.gappers, ...data.momentum, ...data.highRvol];
        const found = allStocks.find(s => s.symbol === selected.symbol);
        if (found) setSelected(found);
      }
      
      // Update watchlist prices
      setWatchlist(prev => prev.map(item => {
        const stock = allNewStocks.find(s => s.symbol === item.symbol);
        if (stock) {
          return { ...item, priceHistory: [...(item.priceHistory || []), stock.price].slice(-10) };
        }
        return item;
      }));
      
    } catch (error) {
      console.error('❌ Failed to fetch data:', error);
      setApiStatus('offline');
    } finally {
      setIsLoading(false);
    }
  }, [selected, alertSettings, alertedSymbols, soundEnabled]);

  // Initial fetch and polling
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Persist preferences
  useEffect(() => { localStorage.setItem(STORAGE.WATCHLIST, JSON.stringify(watchlist)); }, [watchlist]);
  useEffect(() => { localStorage.setItem(STORAGE.ACCOUNT, String(accountSize)); }, [accountSize]);
  useEffect(() => { localStorage.setItem(STORAGE.MY_SETUPS, String(mySetupsOnly)); }, [mySetupsOnly]);
  useEffect(() => { localStorage.setItem(STORAGE.SOUND_ENABLED, String(soundEnabled)); }, [soundEnabled]);
  useEffect(() => {
    if (notesTimeoutRef.current) clearTimeout(notesTimeoutRef.current);
    notesTimeoutRef.current = window.setTimeout(() => localStorage.setItem(STORAGE.NOTES, notes), 500);
  }, [notes]);

  useEffect(() => {
    if (selected) setEntryPrice(selected.price.toFixed(2));
  }, [selected]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(0, prev - 1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => Math.min(filteredStocks.length - 1, prev + 1));
          break;
        case 'Enter':
          if (selectedIndex >= 0 && filteredStocks[selectedIndex]) {
            setSelected(filteredStocks[selectedIndex]);
            chartRef.current?.scrollIntoView({ behavior: 'smooth' });
          }
          break;
        case 'm': case 'M': setMySetupsOnly(prev => !prev); break;
        case 's': case 'S': setSoundEnabled(prev => !prev); break;
        case 'r': case 'R': fetchData(); break;
        case '1': setActiveTab('gappers'); break;
        case '2': setActiveTab('momentum'); break;
        case '3': setActiveTab('highRvol'); break;
        case 'w': case 'W': if (selected) addToWatchlist(selected.symbol); break;
        case 'Escape': setSelected(null); setSelectedIndex(-1); setContextMenu(null); break;
        case '?': setShowShortcuts(true); break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredStocks, selectedIndex, selected, fetchData]);

  useEffect(() => {
    if (selectedIndex >= 0 && filteredStocks[selectedIndex]) {
      setSelected(filteredStocks[selectedIndex]);
    }
  }, [selectedIndex, filteredStocks]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  const addToWatchlist = useCallback((symbol: string) => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    const stock = [...stocks.gappers, ...stocks.momentum, ...stocks.highRvol].find(s => s.symbol === sym);
    setWatchlist(prev => prev.some(w => w.symbol === sym) ? prev : [...prev, { 
      symbol: sym, note: '', addedPrice: stock?.price || 0, color: 'none', priceHistory: stock ? [stock.price] : [],
    }]);
    setWatchInput('');
  }, [stocks]);

  const removeFromWatchlist = useCallback((symbol: string) => {
    setWatchlist(prev => prev.filter(w => w.symbol !== symbol));
  }, []);

  const updateWatchlistItem = useCallback((symbol: string, updates: Partial<WatchlistItem>) => {
    setWatchlist(prev => prev.map(w => w.symbol === symbol ? { ...w, ...updates } : w));
  }, []);

  const openTradingView = (symbol: string) => window.open(`https://www.tradingview.com/chart/?symbol=${symbol}`, '_blank');
  const copySymbol = async (symbol: string) => await navigator.clipboard.writeText(symbol);

  const handleRowClick = (stock: Stock, index: number) => {
    setSelected(stock);
    setSelectedIndex(index);
    chartRef.current?.classList.add('chart-pulse');
    setTimeout(() => chartRef.current?.classList.remove('chart-pulse'), 300);
  };

  const handleRowDoubleClick = (stock: Stock) => openTradingView(stock.symbol);
  const handleRowContextMenu = (e: React.MouseEvent, stock: Stock) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, stock }); };
  const clearAlertCount = () => { setUnreadAlertCount(0); setNewMoversCount(0); };

  // Position Calculator
  const entry = parseFloat(entryPrice) || 0;
  const stop = parseFloat(stopLoss) || 0;
  const riskDollar = accountSize * (riskPercent / 100);
  const riskPerShare = entry - stop;
  const positionSize = riskPerShare > 0 ? Math.floor(riskDollar / riskPerShare) : 0;
  const positionValue = positionSize * entry;
  const exceedsBuyingPower = positionValue > accountSize;

  // Chart URL
  const chartSymbol = selected ? `${selected.exchange}:${selected.symbol}` : 'NASDAQ:AAPL';
  const chartUrl = `https://s.tradingview.com/widgetembed/?frameElementId=tv_widget&symbol=${chartSymbol}&interval=${chartInterval}&theme=dark&style=1&timezone=America%2FNew_York&hide_top_toolbar=1&hide_legend=0&save_image=0&hide_volume=0`;

  // Float data status
  const hasFloatData = filteredStocks.some(s => s.float > 0);

  return (
    <div className="h-full w-full flex flex-col bg-[#0a0f14] font-mono text-[#e2e8f0] grid-bg">
      {/* HEADER */}
      <header className={`h-10 border-b border-[#1e293b] flex items-center justify-between px-4 shrink-0 ${
        preMarket ? 'bg-gradient-to-r from-[#1e1b4b] to-[#312e81]' : 'bg-gradient-to-r from-[#0f1419] to-[#1a2332]'
      }`}>
        <div className="flex items-center gap-4">
          <h1 className="text-[#e2e8f0] font-semibold text-sm tracking-wide">
            {preMarket ? '🌙 Pre-Market Scanner' : '📈 Day Trading Scanner'}
          </h1>
          
          {justOpened && <span className="px-2 py-0.5 bg-[#10b981]/20 text-[#10b981] text-[10px] font-bold rounded animate-pulse">🔔 MARKET OPEN</span>}
          
          <div className="flex gap-1">
            {[{ id: 'gappers', label: 'Gappers' }, { id: 'momentum', label: 'Momentum' }, { id: 'highRvol', label: 'High RVol' }].map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id as ScannerTab)}
                className={`px-3 py-1 text-[11px] font-medium rounded transition-all ${
                  activeTab === tab.id ? preMarket ? 'bg-[#8b5cf6] text-white' : 'bg-[#06b6d4] text-[#0a0f14]' : 'bg-[#111827] text-[#64748b] hover:text-[#e2e8f0]'
                }`}>{tab.label}</button>
            ))}
          </div>
          
          <button onClick={() => setMySetupsOnly(!mySetupsOnly)}
            className={`px-3 py-1 text-[11px] font-medium rounded transition-all ${
              mySetupsOnly ? 'bg-[#06b6d4] text-[#0a0f14] shadow-[0_0_10px_rgba(6,182,212,0.5)]' : 'bg-[#111827] text-[#64748b] hover:text-[#e2e8f0]'
            }`}>🎯 My Setups ({matchingCount})</button>
        </div>
        
        <div className="flex items-center gap-3">
          {isLoading && <span className="text-[11px] text-[#64748b] animate-pulse">Updating...</span>}
          
          <button onClick={() => setSoundEnabled(!soundEnabled)} className={`px-2 py-1 rounded text-[14px] ${soundEnabled ? 'text-[#10b981]' : 'text-[#64748b]'}`} title={soundEnabled ? 'Sound ON' : 'Sound OFF'}>
            {soundEnabled ? '🔊' : '🔇'}
          </button>
          
          <button onClick={clearAlertCount}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-all ${
              unreadAlertCount > 0 ? 'bg-amber-500/20 text-amber-400 animate-pulse' : 'bg-[#111827] text-[#64748b]'
            }`}>🔔 {unreadAlertCount > 0 ? unreadAlertCount : '0'}</button>
          
          <button onClick={fetchData} disabled={isLoading} className="px-2 py-1 bg-[#111827] text-[#64748b] hover:text-[#e2e8f0] rounded text-[11px] disabled:opacity-50">↻</button>
          <button onClick={() => setShowShortcuts(true)} className="px-2 py-1 bg-[#111827] text-[#64748b] hover:text-[#e2e8f0] rounded text-[11px]">?</button>
          
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`w-2 h-2 rounded-full ${apiStatus === 'live' ? 'bg-[#10b981]' : apiStatus === 'delayed' ? 'bg-[#f59e0b]' : 'bg-[#ef4444]'} ${apiStatus !== 'offline' ? 'pulse-dot' : ''}`}></span>
            <span className={apiStatus === 'live' ? 'text-[#10b981]' : apiStatus === 'delayed' ? 'text-[#f59e0b]' : 'text-[#ef4444]'}>
              {apiStatus === 'delayed' ? '15m DELAY' : apiStatus.toUpperCase()}
            </span>
            {!hasFloatData && <span className="text-[#64748b]">• No Float</span>}
          </div>
        </div>
      </header>

      {/* STATS BAR */}
      <div className="h-7 bg-[#111827] border-b border-[#1e293b] px-4 flex items-center gap-6 text-[11px] shrink-0">
        <span className="text-[#64748b]">📊 <span className="text-[#e2e8f0]">{stocks[activeTab].length}</span> Total</span>
        <span className="text-[#64748b]">🎯 <span className="text-[#06b6d4]">{matchingCount}</span> Match</span>
        <span className="text-[#64748b]">🔥 <span className="text-[#f59e0b]">{newMoversCount}</span> New</span>
        <span className="text-[#64748b]">
          Sort: <span className="text-[#06b6d4]">{sortState.column}</span>
          {sortState.direction && <span className="text-[#64748b]"> {sortState.direction === 'desc' ? '▼' : '▲'}</span>}
        </span>
        <span className="ml-auto text-[#64748b]">⏱ <span className="text-[#e2e8f0] font-mono">{currentTime}</span></span>
      </div>

      {/* MAIN */}
      <main className="flex-1 flex gap-2 p-2 overflow-hidden">
        
        {/* LEFT - SCANNER TABLE */}
        <Panel title="Scanner" className="w-[45%]" preMarket={preMarket} headerRight={<span className="text-[10px] text-[#64748b]">{filteredStocks.length} shown</span>}>
          <div className="h-full flex flex-col">
            <div className="flex-1 overflow-auto">
              <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 z-10">
                  <tr className={`uppercase tracking-wider ${preMarket ? 'bg-[#1e1b4b]' : 'bg-[#1e293b]'} text-[#64748b]`}>
                    <SortableHeader column="time" label="Time" sortState={sortState} onSort={handleSort} align="left" />
                    <SortableHeader column="symbol" label="Sym" sortState={sortState} onSort={handleSort} align="left" />
                    <SortableHeader column="price" label="Price" sortState={sortState} onSort={handleSort} />
                    <SortableHeader column="volume" label="Vol" sortState={sortState} onSort={handleSort} />
                    <SortableHeader column="float" label="Float" sortState={sortState} onSort={handleSort} />
                    <SortableHeader column="rVol" label="RVol" sortState={sortState} onSort={handleSort} />
                    <SortableHeader column="gapPercent" label="Gap%" sortState={sortState} onSort={handleSort} />
                    <SortableHeader column="changePercent" label="Chg%" sortState={sortState} onSort={handleSort} />
                    <SortableHeader column="vwapDistance" label="VWAP" sortState={sortState} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody>
                  {filteredStocks.map((stock, index) => {
                    const isSelected = selected?.symbol === stock.symbol || selectedIndex === index;
                    const flash = flashMap[stock.symbol];
                    const isAlerted = alertedSymbols.has(stock.symbol);
                    const vwapStyle = getVwapColor(stock.vwapDistance);
                    const meetsSetup = matchesCriteria(stock);
                    
                    return (
                      <tr key={stock.symbol} onClick={() => handleRowClick(stock, index)} onDoubleClick={() => handleRowDoubleClick(stock)} onContextMenu={(e) => handleRowContextMenu(e, stock)}
                        className={`h-7 border-b border-[#1e293b]/50 cursor-pointer transition-all duration-150 row-hover ${
                          flash === 'up' ? 'flash-green' : flash === 'down' ? 'flash-red' : ''
                        } ${isAlerted ? 'alert-flash' : ''} ${isSelected ? 'bg-[rgba(6,182,212,0.15)] selected-row' : ''}`}
                        style={{ borderLeft: isSelected ? '3px solid #06b6d4' : isAlerted ? '4px solid #f59e0b' : undefined }}>
                        <td className="px-1.5 text-[#64748b] text-[10px]">{stock.time}</td>
                        <td className="px-1.5">
                          <div className="flex items-center gap-1">
                            <span className={`font-semibold ${meetsSetup ? 'text-[#06b6d4]' : 'text-[#e2e8f0]'}`}>{stock.symbol}</span>
                            {isAlerted && <span className="text-[10px]">🔥</span>}
                            {meetsSetup && <span className="text-[8px]">🎯</span>}
                          </div>
                        </td>
                        <td className="px-1.5 text-right">${stock.price.toFixed(2)}</td>
                        <td className="px-1.5 text-right" style={{ backgroundColor: getVolumeColor(stock.volume) }}>{formatNum(stock.volume)}</td>
                        <td className="px-1.5 text-right" style={{ backgroundColor: getFloatColor(stock.float) }}>{stock.float > 0 ? formatNum(stock.float) : '-'}</td>
                        <td className="px-1.5 text-right font-medium" style={{ backgroundColor: getRvolColor(stock.rVol) }}>{stock.rVol.toFixed(1)}x</td>
                        <td className="px-1.5 text-right" style={{ backgroundColor: getPercentColor(stock.gapPercent), color: stock.gapPercent >= 0 ? '#10b981' : '#ef4444' }}>{formatPct(stock.gapPercent)}</td>
                        <td className="px-1.5 text-right" style={{ backgroundColor: getPercentColor(stock.changePercent), color: stock.changePercent >= 0 ? '#10b981' : '#ef4444' }}>{formatPct(stock.changePercent)}</td>
                        <td className="px-1.5 text-right" style={{ backgroundColor: vwapStyle.bg, color: vwapStyle.text }}>{formatPct(stock.vwapDistance)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            
            <div className="h-6 bg-[#1e293b] border-t border-[#1e293b] px-2 flex items-center justify-between text-[10px] text-[#64748b] shrink-0">
              <span>Click headers to sort • Press ? for shortcuts</span>
              <button onClick={() => setShowAlertLog(!showAlertLog)} className="text-[#06b6d4] hover:underline">{showAlertLog ? 'Hide' : 'Show'} Alerts</button>
            </div>
            
            {showAlertLog && (
              <div className="max-h-28 overflow-auto bg-[#0a0f14] border-t border-[#1e293b]">
                {alerts.length === 0 ? <div className="px-2 py-2 text-[10px] text-[#64748b]">No alerts yet</div> : (
                  <ul>
                    {alerts.slice(0, 10).map(alert => (
                      <li key={alert.id} className="px-2 py-1 border-b border-[#1e293b]/30 text-[10px] flex items-center gap-2">
                        <span className="flex-1">{alert.message}</span>
                        <span className="text-[#64748b]">{alert.time}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </Panel>

        {/* MIDDLE - CHART */}
        <div className="w-[30%] flex flex-col gap-2">
          <Panel title="Chart" className="flex-1" preMarket={preMarket}>
            <div ref={chartRef} className="h-full flex flex-col transition-all">
              <div className="px-2 py-1 bg-[#1e293b]/50 flex items-center justify-between shrink-0">
                <span className={`text-[11px] font-medium ${preMarket ? 'text-[#8b5cf6]' : 'text-[#06b6d4]'}`}>{selected?.symbol || 'AAPL'}</span>
                <div className="flex gap-1">
                  {(['1', '5', '15', 'D'] as ChartInterval[]).map(int => (
                    <button key={int} onClick={() => setChartInterval(int)}
                      className={`px-2 py-0.5 text-[10px] rounded ${chartInterval === int ? preMarket ? 'bg-[#8b5cf6] text-white' : 'bg-[#06b6d4] text-[#0a0f14]' : 'bg-[#111827] text-[#64748b] hover:text-[#e2e8f0]'}`}>
                      {int === 'D' ? '1D' : int + 'm'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1"><iframe src={chartUrl} className="w-full h-full border-0" title="TradingView Chart" /></div>
            </div>
          </Panel>

          {/* POSITION CALCULATOR */}
          <Panel title="Position Calculator" className="shrink-0" preMarket={preMarket}>
            <div className="px-2 py-1.5 bg-[#1e293b]/50 flex items-center justify-between cursor-pointer" onClick={() => setCalcOpen(!calcOpen)}>
              <span className="text-[10px] text-[#64748b]">{calcOpen ? '▼' : '▶'}</span>
            </div>
            {calcOpen && (
              <div className="p-2 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div><label className="text-[9px] text-[#64748b] uppercase">Account</label><input type="number" value={accountSize} onChange={e => setAccountSize(Number(e.target.value))} className="w-full bg-[#0a0f14] border border-[#1e293b] rounded px-2 py-1 text-[11px] text-[#e2e8f0]" /></div>
                  <div><label className="text-[9px] text-[#64748b] uppercase">Risk %</label><input type="number" value={riskPercent} onChange={e => setRiskPercent(Number(e.target.value))} className="w-full bg-[#0a0f14] border border-[#1e293b] rounded px-2 py-1 text-[11px] text-[#e2e8f0]" /></div>
                  <div><label className="text-[9px] text-[#64748b] uppercase">Entry</label><input type="text" value={entryPrice} onChange={e => setEntryPrice(e.target.value)} className="w-full bg-[#0a0f14] border border-[#1e293b] rounded px-2 py-1 text-[11px] text-[#e2e8f0]" /></div>
                  <div><label className="text-[9px] text-[#64748b] uppercase">Stop</label><input type="text" value={stopLoss} onChange={e => setStopLoss(e.target.value)} className="w-full bg-[#0a0f14] border border-[#1e293b] rounded px-2 py-1 text-[11px] text-[#e2e8f0]" /></div>
                </div>
                <div className="bg-[#0a0f14] rounded p-2 space-y-1 text-[10px]">
                  <div className="flex justify-between"><span className="text-[#64748b]">Risk $</span><span className="text-[#f59e0b]">${riskDollar.toFixed(0)}</span></div>
                  <div className="flex justify-between"><span className="text-[#64748b]">Size</span><span className="text-[#06b6d4] font-bold">{positionSize} shares</span></div>
                  <div className="flex justify-between"><span className="text-[#64748b]">Value</span><span className={exceedsBuyingPower ? 'text-[#ef4444]' : ''}>${positionValue.toFixed(0)}</span></div>
                  {exceedsBuyingPower && <div className="text-[#ef4444]">⚠ Exceeds BP!</div>}
                </div>
              </div>
            )}
          </Panel>
        </div>

        {/* RIGHT PANEL */}
        <section className="w-[25%] flex flex-col gap-2 overflow-hidden">
          
          {/* STOCK QUOTE */}
          <Panel title="Stock Quote" className="shrink-0" preMarket={preMarket}>
            <div className="p-2">
              {selected ? (
                <>
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className={`text-xl font-bold ${preMarket ? 'text-[#8b5cf6]' : 'text-[#06b6d4]'}`}>{selected.symbol}</span>
                    <span className="text-lg font-bold text-[#e2e8f0]">${selected.price.toFixed(2)}</span>
                    <span className={`text-sm font-medium ${selected.changePercent >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>{formatPct(selected.changePercent)}</span>
                  </div>
                  <div className="text-[9px] text-[#64748b] mb-3">{selected.exchange} • {selected.time}</div>
                  
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] mb-3">
                    <div className="flex justify-between"><span className="text-[#64748b]">Float</span><span className={selected.float > 0 && selected.float < 20000000 ? 'text-[#06b6d4]' : ''}>{selected.float > 0 ? formatNum(selected.float) : 'N/A'}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">MCap</span><span>{selected.marketCap > 0 ? formatNum(selected.marketCap) : 'N/A'}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">VWAP</span><span>${selected.vwap.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">Volume</span><span>{formatNum(selected.volume)}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">RVol</span><span className="text-[#06b6d4]">{selected.rVol.toFixed(1)}x</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">Gap%</span><span className={selected.gapPercent >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}>{formatPct(selected.gapPercent)}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">High</span><span className="text-[#10b981]">${selected.dayHigh.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">Low</span><span className="text-[#ef4444]">${selected.dayLow.toFixed(2)}</span></div>
                  </div>
                  
                  <div className="flex flex-wrap gap-1 mb-3">
                    {selected.strategy.map((s, i) => (
                      <span key={i} className={`px-1.5 py-0.5 text-[9px] rounded ${s.includes('🎯') ? 'bg-[#06b6d4]/30 text-[#06b6d4]' : 'bg-[#f59e0b]/20 text-[#f59e0b]'}`}>{s}</span>
                    ))}
                  </div>
                  
                  <div className="flex gap-2">
                    <button onClick={() => addToWatchlist(selected.symbol)} className="flex-1 py-1 bg-[#06b6d4]/20 hover:bg-[#06b6d4]/30 text-[#06b6d4] text-[10px] rounded">+ Watch</button>
                    <button onClick={() => openTradingView(selected.symbol)} className="flex-1 py-1 bg-[#111827] hover:bg-[#1e293b] text-[#e2e8f0] text-[10px] rounded">📈 TV</button>
                  </div>
                </>
              ) : <div className="text-center py-6 text-[#64748b] text-[11px]">Select a symbol</div>}
            </div>
          </Panel>

          {/* WATCHLIST */}
          <Panel title={`Watchlist (${watchlist.length})`} className="flex-1 min-h-0" preMarket={preMarket}>
            <div className="h-full flex flex-col">
              <div className="px-2 py-1.5 border-b border-[#1e293b] shrink-0">
                <div className="flex gap-1">
                  <input type="text" value={watchInput} onChange={e => setWatchInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && addToWatchlist(watchInput)} placeholder="Add symbol..." className="flex-1 bg-[#0a0f14] border border-[#1e293b] rounded px-2 py-0.5 text-[10px] text-[#e2e8f0] placeholder:text-[#64748b]" />
                  <button onClick={() => addToWatchlist(watchInput)} className="px-2 bg-[#06b6d4]/20 text-[#06b6d4] rounded text-[10px] font-bold">+</button>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                {watchlist.length === 0 ? <div className="text-center py-4 text-[#64748b] text-[10px]">Press W to add selected</div> : (
                  <ul>
                    {watchlist.map(item => {
                      const stock = [...stocks.gappers, ...stocks.momentum, ...stocks.highRvol].find(s => s.symbol === item.symbol);
                      const priceChange = stock && item.addedPrice ? ((stock.price - item.addedPrice) / item.addedPrice) * 100 : 0;
                      const bigMove = Math.abs(priceChange) > 5;
                      
                      return (
                        <li key={item.symbol} className="px-2 py-1.5 border-b border-[#1e293b]/30 hover:bg-[#0a0f14]/50">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <button onClick={() => updateWatchlistItem(item.symbol, { color: item.color === 'green' ? 'yellow' : item.color === 'yellow' ? 'red' : item.color === 'red' ? 'none' : 'green' })} className="text-[10px]">
                                {item.color === 'green' ? '🟢' : item.color === 'yellow' ? '🟡' : item.color === 'red' ? '🔴' : '⚪'}
                              </button>
                              <span className="text-[#06b6d4] font-medium text-[10px] cursor-pointer hover:underline" onClick={() => stock && setSelected(stock)}>{item.symbol}</span>
                              {bigMove && <span className="text-[8px]">⚠️</span>}
                            </div>
                            <div className="flex items-center gap-2">
                              {stock && (<><span className="text-[10px] text-[#e2e8f0]">${stock.price.toFixed(2)}</span><span className={`text-[9px] ${stock.changePercent >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>{formatPct(stock.changePercent)}</span></>)}
                              {item.priceHistory?.length > 1 && <Sparkline data={item.priceHistory} width={40} height={14} />}
                              <button onClick={() => removeFromWatchlist(item.symbol)} className="text-[#64748b] hover:text-[#ef4444] text-[9px]">✕</button>
                            </div>
                          </div>
                          <input type="text" value={item.note} onChange={e => updateWatchlistItem(item.symbol, { note: e.target.value })} placeholder="Note..." className="w-full bg-transparent text-[9px] text-[#64748b] placeholder:text-[#64748b]/50 py-0.5 border-b border-transparent focus:border-[#06b6d4]" />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </Panel>

          {/* NOTES */}
          <Panel title="Notes" className="h-[100px] shrink-0" preMarket={preMarket}>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Trade ideas..." className="w-full h-full bg-[#0a0f14] resize-none p-2 text-[10px] text-[#e2e8f0] placeholder:text-[#64748b]/50 border-none" />
          </Panel>
        </section>
      </main>

      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} stock={contextMenu.stock} onClose={() => setContextMenu(null)} onAddWatchlist={() => addToWatchlist(contextMenu.stock.symbol)} onOpenTV={() => openTradingView(contextMenu.stock.symbol)} onCopy={() => copySymbol(contextMenu.stock.symbol)} />}
    </div>
  );
}

export default App;
