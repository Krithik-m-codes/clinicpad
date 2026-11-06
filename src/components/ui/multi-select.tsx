"use client";

import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";

export interface MultiSelectOption {
  id: string | number;
  name: string;
  description?: string;
}

interface MultiSelectDropdownProps {
  options: MultiSelectOption[];
  value: (string | number)[];
  onChange: (value: (string | number)[]) => void;
  onSearch?: (query: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
  mode?: "id" | "name";
}

const normalize = (s: string) => s.toLowerCase().trim();

export function MultiSelectDropdown({
  options,
  mode = "id", // Default to "id" mode
  value = [],
  onChange,
  onSearch,
  onLoadMore,
  hasMore = false,
  loading = false,
  placeholder = "Select items...",
  searchPlaceholder = "Search...",
  emptyText = "No items found.",
  className,
  disabled = false,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");

  const searchDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadMoreThrottleRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const listRef = React.useRef<HTMLDivElement | null>(null);

  // Cache for selected options to persist badges even when options change
  const selectedCacheRef = React.useRef<Map<string, MultiSelectOption>>(new Map());

  // Update selected cache when value or options change
  React.useEffect(() => {
    // Clear and rebuild the cache
    selectedCacheRef.current.clear();

    value.forEach(val => {
      const stringVal = String(val);

      // Try to find the option in the current options
      const foundOption = options.find(opt =>
        mode === "id"
          ? String(opt.id) === stringVal
          : normalize(opt.name) === normalize(stringVal)
      );

      if (foundOption) {
        selectedCacheRef.current.set(stringVal, foundOption);
      }
    });
  }, [value, options, mode]);

  // Infinite load on scroll (throttled)
  const handleScroll = React.useCallback(() => {
    if (!listRef.current || !hasMore || loading || !searchQuery.trim()) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    if (scrollHeight - scrollTop <= clientHeight * 1.5) {
      if (loadMoreThrottleRef.current) clearTimeout(loadMoreThrottleRef.current);
      loadMoreThrottleRef.current = setTimeout(() => {
        onLoadMore?.();
      }, 120);
    }
  }, [hasMore, loading, onLoadMore, searchQuery]);

  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // Debounced search
  const handleSearch = React.useCallback(
    (val: string) => {
      setSearchQuery(val);
      setOpen(true);
      if (!onSearch) return;
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(() => {
        const q = val.trim();
        if (q.length >= 1 || q === "") onSearch(q);
      }, 300);
    },
    [onSearch]
  );

  // Filtering (local) only if no remote search handler
  const filteredOptions = React.useMemo(() => {
    if (onSearch) return options;
    if (!searchQuery) return options;
    const terms = normalize(searchQuery).split(" ").filter(Boolean);
    return options.filter((o) => {
      const hay = `${o.name} ${o.description ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [options, searchQuery, onSearch]);

  // Helper to check if option is selected
  const isSelected = React.useCallback(
    (option: MultiSelectOption) => {
      return value.some((v) =>
        mode === "id"
          ? String(v) === String(option.id)
          : normalize(String(v)) === normalize(option.name)
      );
    },
    [value, mode]
  );

  // Toggle option selection
  const toggleOption = React.useCallback(
    (option: MultiSelectOption) => {
      const isNowSelected = isSelected(option);

      let nextValue: (string | number)[];

      if (isNowSelected) {
        // Remove the option
        nextValue = value.filter((v) =>
          mode === "id"
            ? String(v) !== String(option.id)
            : normalize(String(v)) !== normalize(option.name)
        );

        // Remove from cache
        const key = mode === "id" ? String(option.id) : normalize(option.name);
        selectedCacheRef.current.delete(key);
      } else {
        // Add the option
        const valueToAdd = mode === "id" ? option.id : option.name;
        nextValue = [...value, valueToAdd];

        // Add to cache
        const key = String(valueToAdd);
        selectedCacheRef.current.set(key, option);
      }

      onChange(nextValue);
    },
    [value, mode, onChange, isSelected]
  );

  // Remove individual item
  const removeItem = React.useCallback(
    (rawVal: string | number) => {
      const nextValue = value.filter((v) => String(v) !== String(rawVal));
      selectedCacheRef.current.delete(String(rawVal));
      onChange(nextValue);
    },
    [onChange, value]
  );

  // Clear all selections
  const clearAll = React.useCallback(() => {
    onChange([]);
    selectedCacheRef.current.clear();
  }, [onChange]);

  // Compute badge items from current value
  const badgeItems = React.useMemo(() => {
    return value.map((v) => {
      const stringVal = String(v);

      // First try the cache
      const cached = selectedCacheRef.current.get(stringVal);
      if (cached) {
        return { key: stringVal, value: v, option: cached };
      }

      // Then try to find in current options
      const foundOption = options.find(opt =>
        mode === "id"
          ? String(opt.id) === stringVal
          : normalize(opt.name) === normalize(stringVal)
      );

      if (foundOption) {
        return { key: stringVal, value: v, option: foundOption };
      }

      // Fallback - create a basic option from the value
      return {
        key: stringVal,
        value: v,
        option: { id: v, name: String(v) } as MultiSelectOption
      };
    });
  }, [value, options, mode]);

  return (
    <div className={cn("w-full", className)}>
      <Popover
        open={open}
        onOpenChange={(isOpen) => {
          setOpen(isOpen);
          if (!isOpen) setSearchQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
              }
            }}
            className={cn(
              "w-full justify-between h-auto min-h-[44px] py-3 px-4",
              "border-2 border-gray-200 hover:border-[var(--primary-color)] focus:border-[var(--primary-color)]",
              "bg-white hover:bg-gray-50 transition-all duration-200",
              "shadow-sm hover:shadow-md",
              "focus:ring-2 focus:ring-[var(--primary-color)] focus:ring-opacity-50 focus:outline-none",
              !value.length && "text-gray-500",
              "font-medium"
            )}
            disabled={disabled}
          >
            <div className="flex flex-wrap gap-2 flex-1 text-left">
              {value.length === 0 ? (
                <span className="text-gray-500 font-normal">{placeholder}</span>
              ) : (
                badgeItems.map(({ key, value: rawVal, option }) => (
                  <Badge
                    key={key}
                    variant="secondary"
                    className="bg-[var(--primary-color)] text-white hover:bg-[var(--primary-color-dark)] 
                               border-0 px-3 py-1 text-sm font-medium rounded-full
                               flex items-center gap-1"
                  >
                    <span className="max-w-[120px] truncate">{option.name}</span>
                    <span
                      className="ml-1 rounded-full outline-none focus:ring-2 focus:ring-white/50 
                                 hover:bg-white/20 p-0.5 transition-colors cursor-pointer"
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          removeItem(rawVal);
                        }
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        removeItem(rawVal);
                      }}
                    >
                      <X className="h-3 w-3 text-white hover:text-gray-200" />
                    </span>
                  </Badge>
                ))
              )}
            </div>
            <ChevronsUpDown className="h-5 w-5 shrink-0 opacity-60 ml-2 text-gray-600" />
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-full p-0 border-2 border-gray-200 shadow-xl" align="start">
          <Command className="rounded-lg">
            <CommandInput
              placeholder={searchPlaceholder}
              value={searchQuery}
              onValueChange={handleSearch}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  const firstItem = document.querySelector("[cmdk-item]") as HTMLElement | null;
                  firstItem?.focus();
                }
              }}
              className="border-0 border-b border-gray-100 focus:ring-2 focus:ring-[var(--primary-color)] focus:ring-opacity-50 px-4 py-3 text-sm"
            />
            <CommandList ref={listRef} className="max-h-64 overflow-auto">
              <CommandEmpty className="py-6 text-center text-sm text-gray-500">{emptyText}</CommandEmpty>
              <CommandGroup className="px-2 py-2">
                {filteredOptions.map((option) => {
                  const selected = isSelected(option);
                  return (
                    <CommandItem
                      key={String(option.id)}
                      value={option.name}
                      onSelect={() => {
                        toggleOption(option);
                        setOpen(true);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleOption(option);
                          setOpen(true);
                        }
                      }}
                      className={cn(
                        "cursor-pointer rounded-md px-3 py-3 mb-1",
                        "hover:bg-[var(--secondary-color)] transition-colors",
                        "flex items-start gap-3",
                        "focus:outline-none focus:ring-2 focus:ring-[var(--primary-color)] focus:ring-opacity-50",
                        selected && "bg-[var(--secondary-color)]"
                      )}
                    >
                      <div
                        className={cn(
                          "rounded-md border-2 w-5 h-5 mt-0.5 flex items-center justify-center shrink-0",
                          selected ? "bg-[var(--primary-color)] border-[var(--primary-color)]" : "border-gray-300 bg-white"
                        )}
                      >
                        {selected && <Check className="h-3 w-3 text-white" />}
                      </div>

                      <div className="flex flex-col flex-1 min-w-0">
                        <span className="font-medium text-gray-900 text-sm leading-5">{option.name}</span>
                        {option.description && <span className="text-xs text-gray-600 mt-1 leading-4">{option.description}</span>}
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>

              {loading && (
                <div className="p-2 text-center text-sm text-gray-500">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Loading more...
                  </div>
                </div>
              )}
            </CommandList>
          </Command>

          {value.length > 0 && (
            <div className="flex items-center justify-between p-3 border-t border-gray-100 bg-gray-50">
              <span className="text-sm text-gray-600 font-medium">
                {value.length} item{value.length > 1 ? "s" : ""} selected
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  clearAll();
                }}
                className="h-8 text-sm text-[var(--primary-color)] hover:text-[var(--primary-color-dark)] hover:bg-[var(--primary-color)]/10 font-medium"
              >
                Clear all
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}