import { Search, Filter } from 'lucide-react';
import type { CategoryCount } from './types';

interface SearchFilterProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedCategory: string;
  onCategoryChange: (category: string) => void;
  categories: CategoryCount[];
  searchPlaceholder?: string;
}

export function SearchFilter({
  searchQuery,
  onSearchChange,
  selectedCategory,
  onCategoryChange,
  categories,
  searchPlaceholder = 'Search apps...',
}: SearchFilterProps) {
  return (
    <div className="flex gap-4 flex-wrap">
      <div className="relative flex-1 min-w-[200px]">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="text"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full pl-10 pr-4 py-2 bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg focus:outline-none focus:border-accent"
        />
      </div>

      {categories.length > 0 && (
        <div className="relative">
          <Filter size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <select
            value={selectedCategory}
            onChange={(e) => onCategoryChange(e.target.value)}
            className="pl-10 pr-8 py-2 bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg focus:outline-none focus:border-accent appearance-none cursor-pointer"
          >
            <option value="">All Categories</option>
            {categories.map(({ category, count }) => (
              <option key={category} value={category}>
                {category} ({count})
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
