import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  fetchScannerData,
  ProcessedStock,
  ApiStatus,
  matchesCriteria,
  isPreMarket,
  isMarketJustOpened,
  formatTime,
  searchTickers,
  fetchTickerSnapshot,
  SearchResult,
  PolygonUpgradeError
} from './api/polygon';
import StockSearch from './components/StockSearch';

// Debug API keys
console.log('🔑 Polygon API Key:', import.meta.env.VITE_POLYGON_API_KEY ? '✓ Present' : '✗ Missing');
console.log('🔑 FMP API Key:', import.meta.env.VITE_FMP_API_KEY ? '✓ Present' : '✗ Missing');

// ============ TYPES ============
interface Stock extends ProcessedStock {}

interface WatchlistItem {
  id: string;
  symbol: string;
  note: string;
  color: 'red' | 'yellow' | 'green' | 'none';
  addedAt: number;
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
  volume: number;
  changeThreshold: number;
  rvolThreshold: number;
}

type ScannerTab = 'gappers' | 'momentum' | 'highRvol';
type SortColumn = 'time' | 'symbol' | 'price' | 'volume' | 'float' | 'rVol' | 'gapPercent' | 'changePercent' | 'vwapDistance';
type SortDirection = 'asc' | 'desc' | null;

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

// ============ MOCK DATA ============
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
    symbol, companyName: symbol, exchange: 'NASDAQ', price, prevPrice: price,
    dayHigh: price * 1.05, dayLow: price * 0.92, dayOpen: price * (1 - gapPercent / 100),
    volume, float: randInt(2000000, 100000000), marketCap: randInt(50000000, 10000000000),
    sector: ['Technology', 'Healthcare', 'Finance', 'Energy'][randInt(0, 4)],
    rVol, prevRVol: rVol, gapPercent, changePercent, prevChangePercent: changePercent,
    vwap, vwapDistance: Math.round(vwapDistance * 100) / 100,
    high52w: price * 2, low52w: price * 0.3, time: formatTime(),
    strategy: gapPercent > 10 ? ['Gap & Go'] : ['Momentum'],
    prevDayClose: price * (1 - changePercent / 100), prevDayVolume: volume * 0.7,
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

// ============ AUDIO ============
const playAlert = (type: 'newMover' | 'breakout' | 'volumeSpike', volume: number = 0.3) => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = type === 'newMover' ? 880 : type === 'breakout' ? 1100 : 660;
    osc.type = 'sine';
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch (e) { console.log('Audio not supported'); }
};

// ============ COLORS ============
const getVolumeColor = (vol: number): string => {
  if (vol >= 50000000) return 'rgba(6, 182, 212, 0.7)';
  if (vol >= 20000000) return 'rgba(6, 182, 212, 0.5)';
  if (vol >= 5000000) return 'rgba(6, 182, 212, 0.3)';
  return 'rgba(6, 182, 212, 0.1)';
};

const getFloatColor = (float: number): string => {
  if (float <= 0) return 'transparent';
  if (float < 5000000) return 'rgba(6, 182, 212, 0.8)';
  if (float < 10000000) return 'rgba(6, 182, 212, 0.6)';
  if (float < 20000000) return 'rgba(6, 182, 212, 0.4)';
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
  return 'rgba(239, 68, 68, 0.3)';
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

const formatPct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

const getTodayDate = () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const getTimestamp = () => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

// ============ STORAGE ============
const STORAGE = { 
  WATCHLIST: 'dtd_watchlist_v2', 
  JOURNAL: 'dtd_journal',
  JOURNAL_SECTIONS: 'dtd_journal_sections',
  MY_SETUPS: 'dtd_my_setups',
  SOUND_ENABLED: 'dtd_sound_enabled',
  SCANNER_SORT: 'dtd_scanner_sort',
};

const DEFAULT_SORT: SortState = { column: 'gapPercent', direction: 'desc' };

// ============ PANEL ============
const Panel = ({ title, children, className = '', headerRight }: { 
  title: string; children: React.ReactNode; className?: string; headerRight?: React.ReactNode;
}) => (
  <div className={`bg-[#111827] border border-[#1e293b] rounded flex flex-col ${className}`}>
    <div className="h-8 bg-gradient-to-r from-[#0f1419] to-[#1a2332] border-b border-[#1e293b] px-3 flex items-center justify-between shrink-0">
      <span className="text-[12px] text-[#06b6d4] font-semibold uppercase tracking-wide">{title}</span>
      {headerRight}
    </div>
    <div className="flex-1 overflow-hidden">{children}</div>
  </div>
);

// ============ SORTABLE HEADER ============
const SortableHeader = ({ column, label, sortState, onSort, align = 'right', width }: { 
  column: SortColumn; label: string; sortState: SortState; onSort: (col: SortColumn) => void; align?: 'left' | 'right'; width?: string;
}) => {
  const isActive = sortState.column === column && sortState.direction !== null;
  const indicator = isActive ? (sortState.direction === 'desc' ? ' ▼' : ' ▲') : '';
  return (
    <th onClick={() => onSort(column)} style={{ width }} className={`px-2 py-2 font-medium cursor-pointer select-none transition-colors hover:bg-[#374151]/50 whitespace-nowrap ${align === 'left' ? 'text-left' : 'text-right'} ${isActive ? 'text-[#06b6d4]' : ''}`}>
      {label}{indicator}
    </th>
  );
};

// ============ KEYBOARD MODAL ============
const ShortcutsModal = ({ onClose }: { onClose: () => void }) => (
  <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
    <div className="bg-[#111827] border border-[#1e293b] rounded-lg p-4 max-w-md" onClick={e => e.stopPropagation()}>
      <h3 className="text-[#06b6d4] font-bold mb-4">⌨️ Keyboard Shortcuts</h3>
      <div className="grid grid-cols-2 gap-2 text-[12px]">
        {[['↑ / ↓', 'Navigate'], ['Enter', 'Select'], ['M', 'My Setups'], ['S', 'Sound'], ['R', 'Refresh'], ['1/2/3', 'Tabs'], ['W', 'Watchlist'], ['?', 'Help']].map(([key, desc]) => (
          <div key={key} className="flex items-center gap-2">
            <kbd className="px-2 py-0.5 bg-[#1e293b] rounded text-[#06b6d4] font-mono">{key}</kbd>
            <span className="text-[#94a3b8]">{desc}</span>
          </div>
        ))}
      </div>
      <button onClick={onClose} className="mt-4 w-full py-2 bg-[#06b6d4]/20 text-[#06b6d4] rounded">Close</button>
    </div>
  </div>
);

// ============ JOURNAL SECTION ============
const JournalSection = ({ title, icon, content, onChange, expanded, onToggle }: {
  title: string; icon: string; content: string; onChange: (val: string) => void; expanded: boolean; onToggle: () => void;
}) => (
  <div className="border-b border-[#1e293b] last:border-0">
    <button onClick={onToggle} className="w-full px-3 py-2 flex items-center justify-between hover:bg-[#1e293b]/30 transition-colors">
      <span className="text-[11px] font-medium text-[#e2e8f0]">{icon} {title}</span>
      <span className="text-[#64748b] text-[10px]">{expanded ? '▼' : '▶'}</span>
    </button>
    {expanded && (
      <textarea
        value={content}
        onChange={e => onChange(e.target.value)}
        placeholder={`Add ${title.toLowerCase()}...`}
        className="w-full bg-[#0a0f14] resize-none px-3 py-2 text-[11px] text-[#e2e8f0] placeholder:text-[#64748b]/50 border-none min-h-[80px] focus:outline-none"
      />
    )}
  </div>
);


// ============ MAIN APP ============
function App() {
  // Scanner state
  const [activeTab, setActiveTab] = useState<ScannerTab>('gappers');
  const [stocks, setStocks] = useState<Record<ScannerTab, Stock[]>>(() => generateMockData());
  const [apiStatus, setApiStatus] = useState<ApiStatus>('offline');
  const [lastUpdate, setLastUpdate] = useState<string>(formatTime());
  const [isLoading, setIsLoading] = useState(false);
  const [selected, setSelected] = useState<Stock | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [flashMap, setFlashMap] = useState<Record<string, 'up' | 'down' | null>>({});
  const [isDemo, setIsDemo] = useState(false);
  
  // Sorting
  const [sortState, setSortState] = useState<SortState>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE.SCANNER_SORT) || '') || DEFAULT_SORT; } catch { return DEFAULT_SORT; }
  });
  
  // Filters
  const [mySetupsOnly, setMySetupsOnly] = useState(() => localStorage.getItem(STORAGE.MY_SETUPS) === 'true');
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem(STORAGE.SOUND_ENABLED) !== 'false');
  
  // Watchlist
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE.WATCHLIST) || '[]'); } catch { return []; }
  });
  const [watchInput, setWatchInput] = useState('');
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  
  // Journal
  const [journalSections, setJournalSections] = useState<{ plan: string; ideas: string; lessons: string }>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE.JOURNAL_SECTIONS) || '{}') || { plan: '', ideas: '', lessons: '' }; } 
    catch { return { plan: '', ideas: '', lessons: '' }; }
  });
  const [expandedSections, setExpandedSections] = useState<{ plan: boolean; ideas: boolean; lessons: boolean }>({ plan: true, ideas: true, lessons: false });
  const [lastSaved, setLastSaved] = useState<string>('');
  
  // Alerts
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertedSymbols, setAlertedSymbols] = useState<Set<string>>(new Set());
  const [unreadAlertCount, setUnreadAlertCount] = useState(0);
  const alertSettings: AlertSettings = { soundEnabled, volume: 0.3, changeThreshold: 3, rvolThreshold: 10 };
  
  // UI
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [currentTime, setCurrentTime] = useState(formatTime());
  
  // Search-loaded stocks (from direct API calls)
  const [searchedStocks, setSearchedStocks] = useState<Map<string, Stock>>(new Map());
  
  const prevStocksRef = useRef<Record<ScannerTab, Stock[]> | null>(null);
  const isFirstRender = useRef(true);
  const journalTimeoutRef = useRef<number>();

  const preMarket = isPreMarket();
  const justOpened = isMarketJustOpened();

  // Get all stocks for lookup (including searched stocks)
  const allStocks = useMemo(() => {
    const scannerStocks = [...stocks.gappers, ...stocks.momentum, ...stocks.highRvol];
    const searched = Array.from(searchedStocks.values());
    return [...scannerStocks, ...searched];
  }, [stocks, searchedStocks]);

  // Clock
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(formatTime()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Sort handler
  const handleSort = useCallback((column: SortColumn) => {
    setSortState(prev => {
      const newDir = prev.column !== column ? 'desc' : prev.direction === 'desc' ? 'asc' : prev.direction === 'asc' ? null : 'desc';
      const newState = { column, direction: newDir };
      localStorage.setItem(STORAGE.SCANNER_SORT, JSON.stringify(newState));
      return newState;
    });
  }, []);

  // Sort stocks
  const sortStocks = useCallback((stocksToSort: Stock[]): Stock[] => {
    if (sortState.direction === null) return stocksToSort;
    return [...stocksToSort].sort((a, b) => {
      let aVal: number | string, bVal: number | string;
      switch (sortState.column) {
        case 'time': aVal = a.time; bVal = b.time; break;
        case 'symbol': aVal = a.symbol; bVal = b.symbol; break;
        case 'price': aVal = a.price; bVal = b.price; break;
        case 'volume': aVal = a.volume; bVal = b.volume; break;
        case 'float': aVal = a.float || 0; bVal = b.float || 0; break;
        case 'rVol': aVal = a.rVol; bVal = b.rVol; break;
        case 'gapPercent': aVal = a.gapPercent; bVal = b.gapPercent; break;
        case 'changePercent': aVal = a.changePercent; bVal = b.changePercent; break;
        case 'vwapDistance': aVal = a.vwapDistance; bVal = b.vwapDistance; break;
        default: return 0;
      }
      if (typeof aVal === 'string' || typeof bVal === 'string') {
        return sortState.direction === 'desc' ? String(bVal).localeCompare(String(aVal)) : String(aVal).localeCompare(String(bVal));
      }
      return sortState.direction === 'desc' ? Number(bVal) - Number(aVal) : Number(aVal) - Number(bVal);
    });
  }, [sortState]);

  // Filtered stocks
  const filteredStocks = useMemo(() => {
    let current = stocks[activeTab];
    if (mySetupsOnly) current = current.filter(matchesCriteria);
    return sortStocks(current);
  }, [stocks, activeTab, mySetupsOnly, sortStocks]);

  const matchingCount = useMemo(() => stocks[activeTab].filter(matchesCriteria).length, [stocks, activeTab]);

  // Fetch data
  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const prevData = prevStocksRef.current;
      const data = await fetchScannerData(prevData ? { gappers: prevData.gappers, momentum: prevData.momentum, highRvol: prevData.highRvol } : undefined);
      
      const allNew = [...data.gappers, ...data.momentum, ...data.highRvol];
      const flashes: Record<string, 'up' | 'down' | null> = {};
      
      if (prevStocksRef.current) {
        const prevLookup = new Map<string, Stock>();
        [...prevStocksRef.current.gappers, ...prevStocksRef.current.momentum, ...prevStocksRef.current.highRvol].forEach(s => prevLookup.set(s.symbol, s));
        allNew.forEach(s => {
          const prev = prevLookup.get(s.symbol);
          if (prev) {
            if (s.price > prev.price) flashes[s.symbol] = 'up';
            else if (s.price < prev.price) flashes[s.symbol] = 'down';
          }
        });
      }
      setFlashMap(flashes);
      setTimeout(() => setFlashMap({}), 600);

      // Alerts
      if (!isFirstRender.current && prevStocksRef.current) {
        const newAlerts: AlertItem[] = [];
        const time = formatTime();
        const timestamp = Date.now();
        const prevSymbols = new Set([...prevStocksRef.current.gappers, ...prevStocksRef.current.momentum, ...prevStocksRef.current.highRvol].map(s => s.symbol));
        
        allNew.forEach(stock => {
          if (!prevSymbols.has(stock.symbol) && matchesCriteria(stock)) {
            newAlerts.push({ id: `${stock.symbol}-new-${timestamp}`, symbol: stock.symbol, type: 'newMover', message: `🔥 ${stock.symbol} new`, time, timestamp });
            if (soundEnabled) playAlert('newMover', alertSettings.volume);
          }
        });
        
        if (newAlerts.length > 0) {
          setAlerts(prev => [...newAlerts, ...prev].slice(0, 20));
          setUnreadAlertCount(prev => prev + newAlerts.length);
          const newAlerted = new Set(alertedSymbols);
          newAlerts.forEach(a => newAlerted.add(a.symbol));
          setAlertedSymbols(newAlerted);
          setTimeout(() => setAlertedSymbols(prev => { const next = new Set(prev); newAlerts.forEach(a => next.delete(a.symbol)); return next; }), 30000);
        }
      }
      isFirstRender.current = false;

      setStocks({ gappers: data.gappers, momentum: data.momentum, highRvol: data.highRvol });
      prevStocksRef.current = { gappers: data.gappers, momentum: data.momentum, highRvol: data.highRvol };
      setApiStatus(data.status);
      setLastUpdate(formatTime());
      
      if (selected) {
        const found = allNew.find(s => s.symbol === selected.symbol);
        if (found) setSelected(found);
      }
    } catch (error) {
      console.error('Fetch error:', error);

      // Handle 403 errors by falling back to demo mode
      if (error instanceof PolygonUpgradeError) {
        console.warn('🎭 Switching to DEMO mode due to API restrictions');
        const mockData = generateMockData();
        setStocks(mockData);
        prevStocksRef.current = mockData;
        setIsDemo(true);
        setApiStatus('offline');
      } else {
        setApiStatus('offline');
      }
    } finally {
      setIsLoading(false);
    }
  }, [selected, alertSettings.volume, alertedSymbols, soundEnabled]);

  useEffect(() => { fetchData(); const i = setInterval(fetchData, 60000); return () => clearInterval(i); }, [fetchData]);

  // Persist
  useEffect(() => { localStorage.setItem(STORAGE.WATCHLIST, JSON.stringify(watchlist)); }, [watchlist]);
  useEffect(() => { localStorage.setItem(STORAGE.MY_SETUPS, String(mySetupsOnly)); }, [mySetupsOnly]);
  useEffect(() => { localStorage.setItem(STORAGE.SOUND_ENABLED, String(soundEnabled)); }, [soundEnabled]);
  useEffect(() => {
    if (journalTimeoutRef.current) clearTimeout(journalTimeoutRef.current);
    journalTimeoutRef.current = window.setTimeout(() => {
      localStorage.setItem(STORAGE.JOURNAL_SECTIONS, JSON.stringify(journalSections));
      setLastSaved(getTimestamp());
    }, 1000);
  }, [journalSections]);

  // Keyboard
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'ArrowUp': e.preventDefault(); setSelectedIndex(p => Math.max(0, p - 1)); break;
        case 'ArrowDown': e.preventDefault(); setSelectedIndex(p => Math.min(filteredStocks.length - 1, p + 1)); break;
        case 'Enter': if (selectedIndex >= 0 && filteredStocks[selectedIndex]) setSelected(filteredStocks[selectedIndex]); break;
        case 'm': case 'M': setMySetupsOnly(p => !p); break;
        case 's': case 'S': setSoundEnabled(p => !p); break;
        case 'r': case 'R': fetchData(); break;
        case '1': setActiveTab('gappers'); break;
        case '2': setActiveTab('momentum'); break;
        case '3': setActiveTab('highRvol'); break;
        case 'w': case 'W': if (selected) addToWatchlist(selected.symbol); break;
        case 'Escape': setSelected(null); setSelectedIndex(-1); break;
        case '?': setShowShortcuts(true); break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [filteredStocks, selectedIndex, selected, fetchData]);

  useEffect(() => {
    if (selectedIndex >= 0 && filteredStocks[selectedIndex]) setSelected(filteredStocks[selectedIndex]);
  }, [selectedIndex, filteredStocks]);

  // Watchlist
  const addToWatchlist = useCallback((symbol: string) => {
    const sym = symbol.trim().toUpperCase();
    if (!sym || watchlist.some(w => w.symbol === sym)) return;
    setWatchlist(prev => [...prev, { id: Date.now().toString(), symbol: sym, note: '', color: 'none', addedAt: Date.now() }]);
    setWatchInput('');
  }, [watchlist]);

  const updateWatchItem = useCallback((id: string, updates: Partial<WatchlistItem>) => {
    setWatchlist(prev => prev.map(w => w.id === id ? { ...w, ...updates } : w));
  }, []);

  const removeFromWatchlist = useCallback((id: string) => {
    setWatchlist(prev => prev.filter(w => w.id !== id));
  }, []);

  const handleDragStart = (id: string) => setDraggedItem(id);
  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedItem || draggedItem === targetId) return;
    setWatchlist(prev => {
      const items = [...prev];
      const dragIdx = items.findIndex(i => i.id === draggedItem);
      const targetIdx = items.findIndex(i => i.id === targetId);
      const [removed] = items.splice(dragIdx, 1);
      items.splice(targetIdx, 0, removed);
      return items;
    });
  };
  const handleDragEnd = () => setDraggedItem(null);

  // Select stock from scanner or watchlist
  const selectStock = useCallback((symbol: string) => {
    const stock = allStocks.find(s => s.symbol === symbol);
    if (stock) setSelected(stock);
  }, [allStocks]);

  // Handle search selection - store in searchedStocks map
  const handleSearchSelect = useCallback((stock: Stock) => {
    setSearchedStocks(prev => {
      const next = new Map(prev);
      next.set(stock.symbol, stock);
      return next;
    });
    setSelected(stock);
  }, []);

  const handleRowClick = (stock: Stock, index: number) => { 
    setSelected(stock); 
    setSelectedIndex(index); 
  };

  const handleRowDoubleClick = (stock: Stock) => {
    addToWatchlist(stock.symbol);
  };

  const handleWatchlistClick = async (symbol: string) => {
    // First check if in scanner data
    const scannerStock = allStocks.find(s => s.symbol === symbol);
    if (scannerStock) {
      setSelected(scannerStock);
      return;
    }
    
    // If not in scanner, fetch from API
    try {
      const stock = await fetchTickerSnapshot(symbol);
      if (stock) {
        setSearchedStocks(prev => {
          const next = new Map(prev);
          next.set(stock.symbol, stock);
          return next;
        });
        setSelected(stock);
      }
    } catch (err) {
      console.error('Failed to fetch watchlist stock:', err);
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-[#0a0f14] font-mono text-[#e2e8f0]">
      {/* HEADER */}
      <header className="h-11 bg-gradient-to-r from-[#0f1419] to-[#1a2332] border-b border-[#1e293b] flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-[#e2e8f0] font-semibold text-sm">{preMarket ? '🌙 Pre-Market' : '📈 Day Trading'} Scanner</h1>
          {isDemo && <span className="px-2 py-0.5 bg-[#f59e0b]/20 text-[#f59e0b] text-[10px] font-bold rounded">DEMO DATA</span>}
          {justOpened && <span className="px-2 py-0.5 bg-[#10b981]/20 text-[#10b981] text-[10px] font-bold rounded animate-pulse">MARKET OPEN</span>}
          
          <div className="flex gap-1">
            {[{ id: 'gappers', label: 'Gappers' }, { id: 'momentum', label: 'Momentum' }, { id: 'highRvol', label: 'High RVol' }].map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id as ScannerTab)}
                className={`px-3 py-1 text-[11px] font-medium rounded ${activeTab === tab.id ? 'bg-[#06b6d4] text-[#0a0f14]' : 'bg-[#111827] text-[#64748b] hover:text-[#e2e8f0]'}`}>{tab.label}</button>
            ))}
          </div>
          
          <button onClick={() => setMySetupsOnly(!mySetupsOnly)}
            className={`px-3 py-1 text-[11px] font-medium rounded ${mySetupsOnly ? 'bg-[#06b6d4] text-[#0a0f14] shadow-[0_0_10px_rgba(6,182,212,0.5)]' : 'bg-[#111827] text-[#64748b]'}`}>
            🎯 My Setups ({matchingCount})
          </button>
        </div>

        <div className="flex items-center gap-3">
          <StockSearch onSelect={handleSearchSelect} />
          {isLoading && <span className="text-[11px] text-[#64748b] animate-pulse">Updating...</span>}
          <button onClick={() => setSoundEnabled(!soundEnabled)} className={`text-[14px] ${soundEnabled ? 'text-[#10b981]' : 'text-[#64748b]'}`}>{soundEnabled ? '🔊' : '🔇'}</button>
          <button onClick={() => setUnreadAlertCount(0)} className={`px-2 py-1 rounded text-[11px] ${unreadAlertCount > 0 ? 'bg-amber-500/20 text-amber-400 animate-pulse' : 'bg-[#111827] text-[#64748b]'}`}>🔔 {unreadAlertCount}</button>
          <button onClick={fetchData} disabled={isLoading} className="px-2 py-1 bg-[#111827] text-[#64748b] hover:text-[#e2e8f0] rounded text-[11px]">↻</button>
          <button onClick={() => setShowShortcuts(true)} className="px-2 py-1 bg-[#111827] text-[#64748b] hover:text-[#e2e8f0] rounded text-[11px]">?</button>
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`w-2 h-2 rounded-full ${apiStatus === 'live' ? 'bg-[#10b981]' : apiStatus === 'delayed' ? 'bg-[#f59e0b]' : 'bg-[#ef4444]'} pulse-dot`}></span>
            <span className={apiStatus === 'live' ? 'text-[#10b981]' : apiStatus === 'delayed' ? 'text-[#f59e0b]' : 'text-[#ef4444]'}>{apiStatus === 'delayed' ? '15m DELAY' : apiStatus.toUpperCase()}</span>
          </div>
        </div>
      </header>

      {/* STATS BAR */}
      <div className="h-7 bg-[#111827] border-b border-[#1e293b] px-4 flex items-center gap-6 text-[11px] shrink-0">
        <span className="text-[#64748b]">📊 <span className="text-[#e2e8f0]">{stocks[activeTab].length}</span></span>
        <span className="text-[#64748b]">🎯 <span className="text-[#06b6d4]">{matchingCount}</span></span>
        <span className="text-[#64748b]">Updated: <span className="text-[#e2e8f0]">{lastUpdate}</span></span>
        <span className="ml-auto text-[#64748b]">⏱ <span className="text-[#e2e8f0]">{currentTime}</span></span>
      </div>

      {/* MAIN */}
      <main className="flex-1 flex gap-2 p-2 overflow-hidden">
        
        {/* LEFT SIDE */}
        <div className="w-[60%] flex flex-col gap-2">
          
          {/* SCANNER */}
          <Panel title="Scanner" className="flex-[2]" headerRight={<span className="text-[10px] text-[#64748b]">{filteredStocks.length} • Double-click to add</span>}>
            <div className="h-full overflow-auto">
              <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 z-10 bg-[#1e293b] text-[#64748b] uppercase tracking-wider">
                  <tr>
                    <SortableHeader column="time" label="Time" sortState={sortState} onSort={handleSort} align="left" width="60px" />
                    <SortableHeader column="symbol" label="Sym" sortState={sortState} onSort={handleSort} align="left" width="60px" />
                    <SortableHeader column="price" label="Price" sortState={sortState} onSort={handleSort} width="70px" />
                    <SortableHeader column="volume" label="Vol" sortState={sortState} onSort={handleSort} width="65px" />
                    <SortableHeader column="float" label="Float" sortState={sortState} onSort={handleSort} width="65px" />
                    <SortableHeader column="rVol" label="RVol" sortState={sortState} onSort={handleSort} width="55px" />
                    <SortableHeader column="gapPercent" label="Gap%" sortState={sortState} onSort={handleSort} width="70px" />
                    <SortableHeader column="changePercent" label="Chg%" sortState={sortState} onSort={handleSort} width="70px" />
                    <SortableHeader column="vwapDistance" label="VWAP" sortState={sortState} onSort={handleSort} width="65px" />
                  </tr>
                </thead>
                <tbody>
                  {filteredStocks.map((stock, index) => {
                    const isSelected = selected?.symbol === stock.symbol;
                    const flash = flashMap[stock.symbol];
                    const isAlerted = alertedSymbols.has(stock.symbol);
                    const vwapStyle = getVwapColor(stock.vwapDistance);
                    const meetsSetup = matchesCriteria(stock);
                    
                    return (
                      <tr key={stock.symbol} 
                        onClick={() => handleRowClick(stock, index)}
                        onDoubleClick={() => handleRowDoubleClick(stock)}
                        className={`h-7 border-b border-[#1e293b]/50 cursor-pointer transition-all ${flash === 'up' ? 'flash-green' : flash === 'down' ? 'flash-red' : ''} ${isAlerted ? 'alert-flash' : ''} ${isSelected ? 'bg-[rgba(6,182,212,0.15)]' : 'hover:bg-[rgba(6,182,212,0.08)]'}`}
                        style={{ borderLeft: isSelected ? '3px solid #06b6d4' : isAlerted ? '3px solid #f59e0b' : undefined }}>
                        <td className="px-2 text-[#64748b] text-[10px]">{stock.time}</td>
                        <td className="px-2">
                          <span className={`font-semibold ${meetsSetup ? 'text-[#06b6d4]' : 'text-[#e2e8f0]'}`}>{stock.symbol}</span>
                          {meetsSetup && <span className="ml-1 text-[8px]">🎯</span>}
                        </td>
                        <td className="px-2 text-right">${stock.price.toFixed(2)}</td>
                        <td className="px-2 text-right" style={{ backgroundColor: getVolumeColor(stock.volume) }}>{formatNum(stock.volume)}</td>
                        <td className="px-2 text-right" style={{ backgroundColor: getFloatColor(stock.float) }}>{stock.float > 0 ? formatNum(stock.float) : '-'}</td>
                        <td className="px-2 text-right font-medium" style={{ backgroundColor: getRvolColor(stock.rVol) }}>{stock.rVol.toFixed(1)}x</td>
                        <td className="px-2 text-right whitespace-nowrap" style={{ backgroundColor: getPercentColor(stock.gapPercent), color: stock.gapPercent >= 0 ? '#10b981' : '#ef4444' }}>{formatPct(stock.gapPercent)}</td>
                        <td className="px-2 text-right whitespace-nowrap" style={{ backgroundColor: getPercentColor(stock.changePercent), color: stock.changePercent >= 0 ? '#10b981' : '#ef4444' }}>{formatPct(stock.changePercent)}</td>
                        <td className="px-2 text-right whitespace-nowrap" style={{ backgroundColor: vwapStyle.bg, color: vwapStyle.text }}>{formatPct(stock.vwapDistance)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* WATCHLIST */}
          <Panel title={`Watchlist (${watchlist.length})`} className="flex-1 min-h-[180px]" headerRight={
            <div className="flex gap-1">
              <input type="text" value={watchInput} onChange={e => setWatchInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && addToWatchlist(watchInput)}
                placeholder="Add symbol..." className="w-24 bg-[#0a0f14] border border-[#1e293b] rounded px-2 py-0.5 text-[10px] text-[#e2e8f0]" />
              <button onClick={() => addToWatchlist(watchInput)} className="px-2 bg-[#06b6d4]/20 text-[#06b6d4] rounded text-[10px]">+</button>
            </div>
          }>
            <div className="h-full overflow-auto">
              {watchlist.length === 0 ? (
                <div className="text-center py-8 text-[#64748b] text-[11px]">Press W or double-click scanner row</div>
              ) : (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-[#1e293b] text-[#64748b] uppercase text-[10px]">
                    <tr>
                      <th className="px-2 py-2 text-left w-8">Tag</th>
                      <th className="px-2 py-2 text-left">Symbol</th>
                      <th className="px-2 py-2 text-right">Price</th>
                      <th className="px-2 py-2 text-right">Chg%</th>
                      <th className="px-2 py-2 text-left">Notes</th>
                      <th className="px-2 py-2 w-6"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {watchlist.map(item => {
                      const stock = allStocks.find(s => s.symbol === item.symbol);
                      const isWatchSelected = selected?.symbol === item.symbol;
                      return (
                        <tr key={item.id} draggable onDragStart={() => handleDragStart(item.id)} onDragOver={e => handleDragOver(e, item.id)} onDragEnd={handleDragEnd}
                          onClick={() => handleWatchlistClick(item.symbol)}
                          className={`border-b border-[#1e293b]/30 cursor-pointer transition-all ${draggedItem === item.id ? 'opacity-50' : ''} ${isWatchSelected ? 'bg-[rgba(6,182,212,0.15)]' : 'hover:bg-[#0a0f14]/50'}`}
                          style={{ borderLeft: isWatchSelected ? '3px solid #06b6d4' : undefined }}>
                          <td className="px-2 py-1.5">
                            <button onClick={e => { e.stopPropagation(); updateWatchItem(item.id, { color: item.color === 'green' ? 'yellow' : item.color === 'yellow' ? 'red' : item.color === 'red' ? 'none' : 'green' }); }} className="text-[12px]">
                              {item.color === 'green' ? '🟢' : item.color === 'yellow' ? '🟡' : item.color === 'red' ? '🔴' : '⚪'}
                            </button>
                          </td>
                          <td className="px-2 py-1.5">
                            <span className="text-[#06b6d4] font-medium">{item.symbol}</span>
                          </td>
                          <td className="px-2 py-1.5 text-right">{stock ? `$${stock.price.toFixed(2)}` : '-'}</td>
                          <td className="px-2 py-1.5 text-right">
                            {stock && <span className={stock.changePercent >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}>{formatPct(stock.changePercent)}</span>}
                          </td>
                          <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                            {editingNote === item.id ? (
                              <input type="text" value={item.note} onChange={e => updateWatchItem(item.id, { note: e.target.value })} 
                                onBlur={() => setEditingNote(null)} onKeyDown={e => e.key === 'Enter' && setEditingNote(null)}
                                autoFocus className="w-full bg-[#0a0f14] border border-[#06b6d4] rounded px-1 py-0.5 text-[10px] text-[#e2e8f0]" />
                            ) : (
                              <span onClick={() => setEditingNote(item.id)} className="text-[10px] text-[#94a3b8] cursor-text hover:text-[#e2e8f0] block truncate max-w-[120px]">
                                {item.note || 'Click to add note...'}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <button onClick={e => { e.stopPropagation(); removeFromWatchlist(item.id); }} className="text-[#64748b] hover:text-[#ef4444] text-[10px]">✕</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>
        </div>

        {/* RIGHT SIDE */}
        <div className="w-[40%] flex flex-col gap-2">
          
          {/* STOCK QUOTE */}
          <Panel title="Stock Quote" className="shrink-0">
            <div className="p-3">
              {selected ? (
                <>
                  <div className="flex items-baseline gap-3 mb-2">
                    <span className="text-2xl font-bold text-[#06b6d4]">{selected.symbol}</span>
                    <span className="text-xl font-bold text-[#e2e8f0]">${selected.price.toFixed(2)}</span>
                    <span className={`text-sm font-medium ${selected.changePercent >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>{formatPct(selected.changePercent)}</span>
                  </div>
                  
                  {selected.sector && <div className="text-[10px] text-[#64748b] mb-3">{selected.sector} • {selected.exchange}</div>}
                  
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[11px] mb-4">
                    <div className="flex justify-between"><span className="text-[#64748b]">Float</span><span className={selected.float > 0 && selected.float < 20000000 ? 'text-[#06b6d4] font-medium' : ''}>{selected.float > 0 ? formatNum(selected.float) : 'N/A'}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">Market Cap</span><span>{selected.marketCap > 0 ? formatNum(selected.marketCap) : 'N/A'}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">RVol</span><span className="text-[#06b6d4] font-medium">{selected.rVol.toFixed(1)}x</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">Gap%</span><span className={selected.gapPercent >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}>{formatPct(selected.gapPercent)}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">Day High</span><span className="text-[#10b981]">${selected.dayHigh.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">Day Low</span><span className="text-[#ef4444]">${selected.dayLow.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">VWAP</span><span>${selected.vwap.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">Volume</span><span>{formatNum(selected.volume)}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">52W High</span><span>{selected.high52w > 0 ? `$${selected.high52w.toFixed(2)}` : 'N/A'}</span></div>
                    <div className="flex justify-between"><span className="text-[#64748b]">52W Low</span><span>{selected.low52w > 0 ? `$${selected.low52w.toFixed(2)}` : 'N/A'}</span></div>
                  </div>
                  
                  <div className="flex flex-wrap gap-1 mb-4">
                    {selected.strategy.map((s, i) => (
                      <span key={i} className={`px-2 py-0.5 text-[10px] rounded ${s.includes('🎯') ? 'bg-[#06b6d4]/30 text-[#06b6d4]' : 'bg-[#f59e0b]/20 text-[#f59e0b]'}`}>{s}</span>
                    ))}
                  </div>
                  
                  <button onClick={() => addToWatchlist(selected.symbol)} className="w-full py-2 bg-[#06b6d4]/20 hover:bg-[#06b6d4]/30 text-[#06b6d4] text-[11px] font-medium rounded">
                    + Add to Watchlist
                  </button>
                </>
              ) : (
                <div className="text-center py-12 text-[#64748b] text-[12px]">Click a row or search a symbol</div>
              )}
            </div>
          </Panel>

          {/* JOURNAL */}
          <Panel title={`Journal — ${getTodayDate()}`} className="flex-1" headerRight={
            lastSaved && <span className="text-[9px] text-[#64748b]">Saved {lastSaved}</span>
          }>
            <div className="h-full overflow-auto">
              <JournalSection 
                title="Pre-Market Plan" 
                icon="📋" 
                content={journalSections.plan} 
                onChange={val => setJournalSections(p => ({ ...p, plan: val }))}
                expanded={expandedSections.plan}
                onToggle={() => setExpandedSections(p => ({ ...p, plan: !p.plan }))}
              />
              <JournalSection 
                title="Trade Ideas" 
                icon="💡" 
                content={journalSections.ideas} 
                onChange={val => setJournalSections(p => ({ ...p, ideas: val }))}
                expanded={expandedSections.ideas}
                onToggle={() => setExpandedSections(p => ({ ...p, ideas: !p.ideas }))}
              />
              <JournalSection 
                title="Lessons Learned" 
                icon="📝" 
                content={journalSections.lessons} 
                onChange={val => setJournalSections(p => ({ ...p, lessons: val }))}
                expanded={expandedSections.lessons}
                onToggle={() => setExpandedSections(p => ({ ...p, lessons: !p.lessons }))}
              />
            </div>
          </Panel>
        </div>
      </main>

      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}

export default App;
