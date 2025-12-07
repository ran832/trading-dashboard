import { useState, useEffect, useRef } from 'react';
import { searchTickers, fetchTickerSnapshot, SearchResult, ProcessedStock } from '../api/polygon';

interface StockSearchProps {
  onSelect: (stock: ProcessedStock) => void;
}

const FALLBACK_SYMBOLS = ['NVDA', 'TSLA', 'AMD', 'META', 'AAPL', 'GOOGL', 'AMZN', 'MSFT', 'PLTR', 'SOFI'];

export default function StockSearch({ onSelect }: StockSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number>();

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.length < 1) {
      setResults([]);
      setShowDropdown(false);
      return;
    }

    debounceRef.current = window.setTimeout(async () => {
      setIsSearching(true);
      try {
        const data = await searchTickers(query);

        // If API returns no results, try fallback local search
        if (data.length === 0) {
          const localMatches = FALLBACK_SYMBOLS.filter(s =>
            s.toLowerCase().includes(query.toLowerCase())
          ).map(ticker => ({
            ticker,
            name: ticker,
            market: 'stocks',
            locale: 'us',
            primary_exchange: 'XNAS',
            type: 'CS',
            active: true,
            currency_name: 'usd'
          } as SearchResult));
          setResults(localMatches);
          setShowDropdown(localMatches.length > 0);
        } else {
          setResults(data);
          setShowDropdown(data.length > 0);
        }

        setSelectedIdx(-1);
      } catch (err) {
        // On error, use fallback
        const localMatches = FALLBACK_SYMBOLS.filter(s =>
          s.toLowerCase().includes(query.toLowerCase())
        ).map(ticker => ({
          ticker,
          name: ticker,
          market: 'stocks',
          locale: 'us',
          primary_exchange: 'XNAS',
          type: 'CS',
          active: true,
          currency_name: 'usd'
        } as SearchResult));
        setResults(localMatches);
        setShowDropdown(localMatches.length > 0);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const handleSelectSymbol = async (symbol: string) => {
    setIsLoading(true);
    setError(null);
    setShowDropdown(false);

    try {
      const stock = await fetchTickerSnapshot(symbol.toUpperCase());
      if (stock) {
        onSelect(stock);
        setQuery('');
      } else {
        setError(`Symbol "${symbol}" not found`);
      }
    } catch (err) {
      setError('Failed to fetch quote');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      handleSelectSymbol(query.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDropdown || results.length === 0) {
      if (e.key === 'Enter') handleSubmit(e);
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIdx(prev => Math.min(prev + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIdx(prev => Math.max(prev - 1, -1));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIdx >= 0 && results[selectedIdx]) {
          handleSelectSymbol(results[selectedIdx].ticker);
        } else if (query.trim()) {
          handleSelectSymbol(query.trim());
        }
        break;
      case 'Escape':
        setShowDropdown(false);
        break;
    }
  };

  return (
    <div ref={searchRef} className="relative">
      <form onSubmit={handleSubmit} className="flex items-center gap-1">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value.toUpperCase())}
            onKeyDown={handleKeyDown}
            onFocus={() => results.length > 0 && setShowDropdown(true)}
            placeholder="Search symbol..."
            className="w-32 bg-[#0a0f14] border border-[#1e293b] rounded px-2 py-1 text-[11px] text-[#e2e8f0] placeholder:text-[#64748b] focus:border-[#06b6d4] focus:outline-none"
          />
          {(isSearching || isLoading) && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              <div className="w-3 h-3 border border-[#06b6d4] border-t-transparent rounded-full animate-spin"></div>
            </div>
          )}
        </div>
        <button
          type="submit"
          disabled={isLoading || !query.trim()}
          className="px-2 py-1 bg-[#06b6d4]/20 text-[#06b6d4] rounded text-[10px] hover:bg-[#06b6d4]/30 disabled:opacity-50"
        >
          🔍
        </button>
      </form>

      {/* Dropdown */}
      {showDropdown && results.length > 0 && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-[#111827] border border-[#1e293b] rounded shadow-lg z-50 max-h-64 overflow-auto">
          {results.map((result, idx) => (
            <button
              key={result.ticker}
              onClick={() => handleSelectSymbol(result.ticker)}
              className={`w-full px-3 py-2 text-left flex items-center justify-between hover:bg-[#1e293b] transition-colors ${
                idx === selectedIdx ? 'bg-[#1e293b]' : ''
              }`}
            >
              <div>
                <span className="text-[#06b6d4] font-medium text-[12px]">{result.ticker}</span>
                <span className="text-[#64748b] text-[10px] ml-2 truncate">{result.name}</span>
              </div>
              <span className="text-[#64748b] text-[9px]">{result.primary_exchange}</span>
            </button>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="absolute top-full left-0 mt-1 px-2 py-1 bg-[#ef4444]/20 border border-[#ef4444]/50 rounded text-[#ef4444] text-[10px]">
          {error}
        </div>
      )}
    </div>
  );
}
