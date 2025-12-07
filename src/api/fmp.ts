// Financial Modeling Prep API for Float Data

const FMP_KEY = import.meta.env.VITE_FMP_API_KEY;
const FMP_URL = 'https://financialmodelingprep.com/stable';

// ============ TYPES ============
export interface FMPProfile {
  symbol: string;
  companyName: string;
  exchange: string;
  sector: string;
  industry: string;
  marketCap: number;
  floatShares: number;
  sharesOutstanding: number;
  avgVolume: number;
}

export interface FloatData {
  float: number;
  marketCap: number;
  sector: string;
  avgVolume: number;
}

// ============ CACHE ============
const CACHE_KEY = 'dtd_fmp_cache';
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  data: FloatData;
  timestamp: number;
}

interface Cache {
  [symbol: string]: CacheEntry;
}

const getCache = (): Cache => {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    return cached ? JSON.parse(cached) : {};
  } catch {
    return {};
  }
};

const setCache = (cache: Cache) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    console.warn('Failed to save FMP cache:', e);
  }
};

const getCachedData = (symbol: string): FloatData | null => {
  const cache = getCache();
  const entry = cache[symbol];
  
  if (entry && Date.now() - entry.timestamp < CACHE_EXPIRY) {
    return entry.data;
  }
  return null;
};

const setCachedData = (symbol: string, data: FloatData) => {
  const cache = getCache();
  cache[symbol] = {
    data,
    timestamp: Date.now(),
  };
  setCache(cache);
};

// ============ API FUNCTIONS ============

/**
 * Fetch profile data for a single symbol
 */
export const fetchProfile = async (symbol: string): Promise<FloatData | null> => {
  if (!FMP_KEY) {
    console.warn('FMP API key not configured');
    return null;
  }

  // Check cache first
  const cached = getCachedData(symbol);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(
      `${FMP_URL}/profile?symbol=${symbol}&apikey=${FMP_KEY}`
    );
    
    if (!response.ok) {
      console.warn(`FMP API error for ${symbol}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    
    if (data && data.length > 0) {
      const profile = data[0];
      const floatData: FloatData = {
        float: profile.floatShares || 0,
        marketCap: profile.marketCap || 0,
        sector: profile.sector || 'Unknown',
        avgVolume: profile.avgVolume || 0,
      };
      
      // Cache the result
      setCachedData(symbol, floatData);
      return floatData;
    }
    
    return null;
  } catch (error) {
    console.warn(`Failed to fetch FMP data for ${symbol}:`, error);
    return null;
  }
};

/**
 * Fetch profile data for multiple symbols (batched)
 * Respects rate limits by processing in chunks
 */
export const fetchProfilesBatch = async (
  symbols: string[],
  maxConcurrent: number = 3
): Promise<Map<string, FloatData>> => {
  const results = new Map<string, FloatData>();
  
  if (!FMP_KEY) {
    console.warn('FMP API key not configured');
    return results;
  }

  // Filter out cached symbols
  const toFetch: string[] = [];
  
  for (const symbol of symbols) {
    const cached = getCachedData(symbol);
    if (cached) {
      results.set(symbol, cached);
    } else {
      toFetch.push(symbol);
    }
  }

  // Fetch uncached symbols in batches
  const batches: string[][] = [];
  for (let i = 0; i < toFetch.length; i += maxConcurrent) {
    batches.push(toFetch.slice(i, i + maxConcurrent));
  }

  for (const batch of batches) {
    const promises = batch.map(async symbol => {
      const data = await fetchProfile(symbol);
      if (data) {
        results.set(symbol, data);
      }
    });

    await Promise.all(promises);
    
    // Small delay between batches to respect rate limits
    if (batches.indexOf(batch) < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return results;
};

/**
 * Clear expired cache entries
 */
export const cleanCache = () => {
  const cache = getCache();
  const now = Date.now();
  let cleaned = false;

  for (const symbol of Object.keys(cache)) {
    if (now - cache[symbol].timestamp > CACHE_EXPIRY) {
      delete cache[symbol];
      cleaned = true;
    }
  }

  if (cleaned) {
    setCache(cache);
  }
};

/**
 * Get cache stats
 */
export const getCacheStats = (): { total: number; valid: number } => {
  const cache = getCache();
  const now = Date.now();
  let valid = 0;

  for (const symbol of Object.keys(cache)) {
    if (now - cache[symbol].timestamp < CACHE_EXPIRY) {
      valid++;
    }
  }

  return {
    total: Object.keys(cache).length,
    valid,
  };
};

