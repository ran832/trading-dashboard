// Polygon.io API Integration + FMP Float Data

import { fetchProfilesBatch, FloatData } from './fmp';

const POLYGON_KEY = import.meta.env.VITE_POLYGON_API_KEY;
const POLYGON_URL = 'https://api.polygon.io';

// ============ ERRORS ============
export class PolygonUpgradeError extends Error {
  constructor(message: string = 'Polygon API requires plan upgrade (403)') {
    super(message);
    this.name = 'PolygonUpgradeError';
  }
}

// ============ TYPES ============
export interface PolygonTicker {
  ticker: string;
  todaysChangePerc: number;
  todaysChange: number;
  updated: number;
  day: {
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    vw: number;
  };
  prevDay: {
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    vw: number;
  };
  min?: {
    av: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    vw: number;
  };
}

export interface ProcessedStock {
  symbol: string;
  companyName: string;
  exchange: string;
  price: number;
  prevPrice: number;
  dayHigh: number;
  dayLow: number;
  dayOpen: number;
  volume: number;
  float: number;
  marketCap: number;
  sector: string;
  rVol: number;
  prevRVol: number;
  gapPercent: number;
  changePercent: number;
  prevChangePercent: number;
  vwap: number;
  vwapDistance: number;
  high52w: number;
  low52w: number;
  time: string;
  strategy: string[];
  prevDayClose: number;
  prevDayVolume: number;
  isNew?: boolean;
  priceHistory: number[];
}

export type ApiStatus = 'live' | 'delayed' | 'offline';

// ============ TIME HELPERS ============
export const formatTime = () => {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
};

export const isPreMarket = (): boolean => {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const time = hours * 60 + minutes;
  const day = now.getDay();
  
  const preMarketStart = 4 * 60;
  const marketOpen = 9 * 60 + 30;
  
  return day >= 1 && day <= 5 && time >= preMarketStart && time < marketOpen;
};

export const isMarketOpen = (): boolean => {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const time = hours * 60 + minutes;
  const day = now.getDay();
  
  const marketOpen = 9 * 60 + 30;
  const marketClose = 16 * 60;
  
  return day >= 1 && day <= 5 && time >= marketOpen && time < marketClose;
};

export const isMarketJustOpened = (): boolean => {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const time = hours * 60 + minutes;
  
  const marketOpen = 9 * 60 + 30;
  return time >= marketOpen && time < marketOpen + 5;
};

// ============ STRATEGY DETECTION ============
const getStrategy = (stock: Partial<ProcessedStock>): string[] => {
  const tags: string[] = [];
  const float = stock.float || 0;
  const rVol = stock.rVol || 0;
  const gap = stock.gapPercent || 0;
  const change = stock.changePercent || 0;
  const price = stock.price || 0;
  const vwapDist = stock.vwapDistance || 0;
  
  // Perfect setup check
  const isPerfect = float > 0 && float < 20000000 && gap >= 4 && price >= 1 && price <= 20 && rVol >= 5;
  if (isPerfect) tags.push('🎯 Perfect Setup');
  
  if (float > 0 && float < 10000000 && rVol > 5) tags.push('Low Float Runner');
  if (gap > 20) tags.push('Squeeze Alert');
  if (vwapDist > -2 && vwapDist < 2 && change > 3) tags.push('VWAP Reclaim');
  if (price >= (stock.dayHigh || 0) * 0.99 && change > 0) tags.push('HOD Break');
  if (gap > 10 && rVol > 3) tags.push('Gap & Go');
  
  if (tags.length === 0 && change > 5) tags.push('Momentum');
  if (tags.length === 0) tags.push('In Play');
  
  return tags.slice(0, 3); // Max 3 tags
};

// ============ POLYGON API ============
let logged403 = false;

export const fetchGainers = async (): Promise<PolygonTicker[]> => {
  const response = await fetch(`${POLYGON_URL}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${POLYGON_KEY}`);
  if (response.status === 403) {
    if (!logged403) {
      console.warn('⚠️ Polygon API 403: Plan upgrade required for gainers/losers endpoints');
      logged403 = true;
    }
    throw new PolygonUpgradeError();
  }
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  const data = await response.json();
  return data.tickers || [];
};

export const fetchLosers = async (): Promise<PolygonTicker[]> => {
  const response = await fetch(`${POLYGON_URL}/v2/snapshot/locale/us/markets/stocks/losers?apiKey=${POLYGON_KEY}`);
  if (response.status === 403) {
    if (!logged403) {
      console.warn('⚠️ Polygon API 403: Plan upgrade required for gainers/losers endpoints');
      logged403 = true;
    }
    throw new PolygonUpgradeError();
  }
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  const data = await response.json();
  return data.tickers || [];
};

// ============ PROCESS TICKER ============
export const processPolygonTicker = (
  ticker: PolygonTicker, 
  prevData?: ProcessedStock,
  floatData?: FloatData
): ProcessedStock => {
  const price = ticker.day?.c || ticker.prevDay?.c || 0;
  const prevDayClose = ticker.prevDay?.c || price;
  const dayOpen = ticker.day?.o || prevDayClose;
  const volume = ticker.day?.v || 0;
  const prevDayVolume = ticker.prevDay?.v || 1;
  const vwap = ticker.day?.vw || (ticker.day?.h + ticker.day?.l + ticker.day?.c) / 3 || price;
  
  const gapPercent = prevDayClose > 0 ? ((dayOpen - prevDayClose) / prevDayClose) * 100 : 0;
  
  // Calculate RVol using FMP avg volume if available, else use prev day
  const avgVol = floatData?.avgVolume || prevDayVolume;
  const rVol = avgVol > 0 ? volume / avgVol : 1;
  
  const vwapDistance = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;
  
  const priceHistory = prevData?.priceHistory ? [...prevData.priceHistory, price].slice(-10) : [price];
  
  const stock: ProcessedStock = {
    symbol: ticker.ticker,
    companyName: ticker.ticker,
    exchange: 'NASDAQ',
    price,
    prevPrice: prevData?.price || price,
    dayHigh: ticker.day?.h || price,
    dayLow: ticker.day?.l || price,
    dayOpen,
    volume,
    float: floatData?.float || prevData?.float || 0,
    marketCap: floatData?.marketCap || prevData?.marketCap || 0,
    sector: floatData?.sector || prevData?.sector || '',
    rVol: Math.round(rVol * 100) / 100,
    prevRVol: prevData?.rVol || rVol,
    gapPercent: Math.round(gapPercent * 100) / 100,
    changePercent: Math.round((ticker.todaysChangePerc || 0) * 100) / 100,
    prevChangePercent: prevData?.changePercent || ticker.todaysChangePerc || 0,
    vwap,
    vwapDistance: Math.round(vwapDistance * 100) / 100,
    high52w: 0,
    low52w: 0,
    time: formatTime(),
    strategy: [],
    prevDayClose,
    prevDayVolume,
    isNew: !prevData,
    priceHistory,
  };
  
  stock.strategy = getStrategy(stock);
  return stock;
};

// ============ FETCH ALL DATA ============
export const fetchScannerData = async (
  prevData?: { gappers: ProcessedStock[]; momentum: ProcessedStock[]; highRvol: ProcessedStock[] }
): Promise<{
  gappers: ProcessedStock[];
  momentum: ProcessedStock[];
  highRvol: ProcessedStock[];
  status: ApiStatus;
}> => {
  try {
    const gainers = await fetchGainers();
    
    // Build previous data lookup
    const prevLookup = new Map<string, ProcessedStock>();
    if (prevData) {
      [...prevData.gappers, ...prevData.momentum, ...prevData.highRvol].forEach(s => {
        prevLookup.set(s.symbol, s);
      });
    }
    
    // Get float data from FMP (batched, cached)
    const symbols = gainers.map(t => t.ticker);
    const floatMap = await fetchProfilesBatch(symbols, 5);
    
    // Process all tickers
    const processed = gainers.map(t => 
      processPolygonTicker(t, prevLookup.get(t.ticker), floatMap.get(t.ticker))
    );
    
    const validStocks = processed.filter(s => s.price > 0 && s.volume > 0);
    
    // TOP GAPPERS: Sort by gap%, filter gap > 4%
    const gappers = [...validStocks]
      .filter(s => s.gapPercent > 4)
      .sort((a, b) => b.gapPercent - a.gapPercent)
      .slice(0, 25);
    
    // MOMENTUM: Sort by change%, filter change > 5%
    const momentum = [...validStocks]
      .filter(s => s.changePercent > 5)
      .sort((a, b) => b.changePercent - a.changePercent)
      .slice(0, 25);
    
    // HIGH RVOL: Sort by relative volume
    const highRvol = [...validStocks]
      .filter(s => s.rVol > 1.5)
      .sort((a, b) => b.rVol - a.rVol)
      .slice(0, 25);
    
    return {
      gappers: gappers.length > 0 ? gappers : validStocks.slice(0, 25),
      momentum: momentum.length > 0 ? momentum : validStocks.slice(0, 25),
      highRvol: highRvol.length > 0 ? highRvol : validStocks.slice(0, 25),
      status: 'delayed' as ApiStatus,
    };
  } catch (error) {
    console.error('Polygon API Error:', error);
    throw error;
  }
};

// ============ CRITERIA CHECK ============
export const matchesCriteria = (stock: ProcessedStock): boolean => {
  return (
    stock.gapPercent >= 4 &&
    stock.price >= 1 &&
    stock.price <= 20 &&
    stock.rVol >= 5 &&
    (stock.float === 0 || stock.float < 20000000) // Pass if no float data OR float < 20M
  );
};

// ============ SEARCH TYPES ============
export interface SearchResult {
  ticker: string;
  name: string;
  market: string;
  locale: string;
  primary_exchange: string;
  type: string;
  active: boolean;
  currency_name: string;
}

// ============ SEARCH AUTOCOMPLETE ============
export const searchTickers = async (query: string): Promise<SearchResult[]> => {
  if (!query || query.length < 1) return [];
  
  // Debug logging
  console.log('🔍 Searching for:', query);
  console.log('🔑 API Key present:', !!POLYGON_KEY);
  console.log('🌐 Full URL:', `${POLYGON_URL}/v3/reference/tickers?search=${query}&active=true&limit=10&apiKey=${POLYGON_KEY ? 'PRESENT' : 'MISSING'}`);
  
  try {
    const response = await fetch(
      `${POLYGON_URL}/v3/reference/tickers?search=${encodeURIComponent(query)}&active=true&limit=10&apiKey=${POLYGON_KEY}`
    );
    
    // Debug logging
    console.log('📡 Search response status:', response.status);
    
    if (!response.ok) throw new Error(`Search API Error: ${response.status}`);
    const data = await response.json();
    
    // Debug logging
    console.log('📊 Search results:', data);
    
    return data.results || [];
  } catch (error) {
    console.error('❌ Search error:', error);
    return [];
  }
};

// ============ FETCH SINGLE TICKER SNAPSHOT ============
export const fetchTickerSnapshot = async (symbol: string): Promise<ProcessedStock | null> => {
  // Debug logging
  console.log('📈 Fetching snapshot for:', symbol);
  console.log('🔑 API Key present:', !!POLYGON_KEY);
  
  try {
    const response = await fetch(
      `${POLYGON_URL}/v2/snapshot/locale/us/markets/stocks/tickers/${symbol.toUpperCase()}?apiKey=${POLYGON_KEY}`
    );
    
    // Debug logging
    console.log('📡 Snapshot response status:', response.status);
    
    if (!response.ok) {
      if (response.status === 404) {
        console.log('⚠️ Symbol not found (404)');
        return null;
      }
      throw new Error(`API Error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Debug logging
    console.log('📊 Snapshot data:', data);
    
    const ticker = data.ticker as PolygonTicker;
    
    if (!ticker) {
      console.log('⚠️ No ticker in response');
      return null;
    }
    
    // Get float data from FMP
    const floatMap = await fetchProfilesBatch([ticker.ticker], 1);
    const floatData = floatMap.get(ticker.ticker);
    
    const processed = processPolygonTicker(ticker, undefined, floatData);
    console.log('✅ Processed stock:', processed);
    
    return processed;
  } catch (error) {
    console.error('❌ Fetch ticker error:', error);
    return null;
  }
};
