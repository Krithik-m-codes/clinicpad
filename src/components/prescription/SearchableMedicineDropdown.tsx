import React, { useState, useEffect, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ChevronDown, Search, X } from 'lucide-react';
import { MedicinesRepository } from '@/lib/db/repositories/MedicinesRepository';
import { Medicine } from '@/lib/db/dbManager';

const medicinesRepository = new MedicinesRepository();

interface SearchableMedicineDropdownProps {
    value?: string;
    onChange: (medicine: Medicine | null, medicineName: string) => void;
    placeholder?: string;
    className?: string;
}

export const SearchableMedicineDropdown: React.FC<SearchableMedicineDropdownProps> = ({
    value = '',
    onChange,
    placeholder = 'Search medicine...',
    className = ''
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState(value);
    const [searchResults, setSearchResults] = useState<Medicine[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const [loading, setLoading] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const searchMedicines = async () => {
            if (!searchQuery.trim()) {
                setSearchResults([]);
                return;
            }

            setLoading(true);
            try {
                const results = await medicinesRepository.search(searchQuery, 1, 20);
                setSearchResults(results.data);
                setSelectedIndex(-1);
            } catch (error) {
                console.error('Error searching medicines:', error);
                setSearchResults([]);
            } finally {
                setLoading(false);
            }
        };

        const debounceTimeout = setTimeout(searchMedicines, 300);
        return () => clearTimeout(debounceTimeout);
    }, [searchQuery]);

    useEffect(() => {
        setSearchQuery(value);
    }, [value]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const query = e.target.value;
        setSearchQuery(query);
        setIsOpen(true);
        onChange(null, query); // Pass the raw input value
    };

    const handleMedicineSelect = (medicine: Medicine) => {
        setSearchQuery(medicine.name);
        setIsOpen(false);
        onChange(medicine, medicine.name);
    };

    // Track which key was last pressed for visual feedback
    const [lastKeyPressed, setLastKeyPressed] = useState<string | null>(null);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        setLastKeyPressed(e.key); // Update the last pressed key
        setTimeout(() => setLastKeyPressed(null), 200); // Clear after 200ms

        if (!isOpen) {
            if (e.key === 'ArrowDown' || e.key === 'Enter') {
                setIsOpen(true);
                return;
            }
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = prev < searchResults.length - 1 ? prev + 1 : prev;
                    // Scroll the item into view if needed
                    const element = document.querySelector(`[data-index="${newIndex}"]`);
                    element?.scrollIntoView({ block: 'nearest' });
                    return newIndex;
                });
                break;
            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = prev > 0 ? prev - 1 : -1;
                    // Scroll the item into view if needed
                    const element = document.querySelector(`[data-index="${newIndex}"]`);
                    element?.scrollIntoView({ block: 'nearest' });
                    return newIndex;
                });
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < searchResults.length) {
                    handleMedicineSelect(searchResults[selectedIndex]);
                }
                break;
            case 'Escape':
                e.preventDefault();
                setIsOpen(false);
                inputRef.current?.blur();
                break;
            case 'Tab':
                if (isOpen) {
                    setIsOpen(false);
                }
                break;
            case 'Home':
                if (isOpen) {
                    e.preventDefault();
                    setSelectedIndex(0);
                    const element = document.querySelector('[data-index="0"]');
                    element?.scrollIntoView({ block: 'nearest' });
                }
                break;
            case 'End':
                if (isOpen) {
                    e.preventDefault();
                    const lastIndex = searchResults.length - 1;
                    setSelectedIndex(lastIndex);
                    const element = document.querySelector(`[data-index="${lastIndex}"]`);
                    element?.scrollIntoView({ block: 'nearest' });
                }
                break;
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && searchResults[selectedIndex]) {
                    handleMedicineSelect(searchResults[selectedIndex]);
                }
                break;
            case 'Escape':
                setIsOpen(false);
                setSelectedIndex(-1);
                break;
        }
    };

    const clearInput = () => {
        setSearchQuery('');
        onChange(null, '');
        inputRef.current?.focus();
    };

    const highlightMatch = (text: string, query: string) => {
        if (!query.trim()) return text;

        const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        const parts = text.split(regex);

        return parts.map((part, index) =>
            regex.test(part) ?
                <span key={index} className="bg-yellow-200 font-semibold">{part}</span> :
                part
        );
    };

    return (
        <div ref={dropdownRef} className={`relative ${className}`}>
            <div className="relative">
                <Input
                    ref={inputRef}
                    type="text"
                    value={searchQuery}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onFocus={() => setIsOpen(true)}
                    placeholder={placeholder}
                    className="pr-16 focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300"
                    autoComplete="off"
                />
                <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    {searchQuery && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={clearInput}
                            className="h-6 w-6 p-0 hover:bg-gray-100"
                        >
                            <X className="h-3 w-3" />
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setIsOpen(!isOpen)}
                        className="h-6 w-6 p-0 hover:bg-gray-100"
                    >
                        <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </Button>
                </div>
            </div>

            {isOpen && (
                <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-auto">
                    {loading ? (
                        <div className="px-3 py-4 text-center text-gray-500">
                            <div className="flex items-center justify-center gap-2">
                                <div className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin"></div>
                                <span className="text-sm">Searching medicines...</span>
                            </div>
                        </div>
                    ) : searchResults.length > 0 ? (
                        <>
                            <div className="px-3 py-2 text-xs text-gray-500 bg-gray-50 border-b flex items-center gap-2">
                                <Search className="h-3 w-3" />
                                Found {searchResults.length} medicine{searchResults.length !== 1 ? 's' : ''}
                                {searchQuery && ` for "${searchQuery}"`}
                            </div>
                            {searchResults.map((medicine, index) => (
                                <div
                                    key={medicine.id}
                                    data-index={index}
                                    onClick={() => handleMedicineSelect(medicine)}
                                    className={`px-3 py-2 cursor-pointer border-b border-gray-100 last:border-b-0
                                        ${index === selectedIndex ? 'bg-emerald-50 ring-2 ring-emerald-200 relative' : 'hover:bg-emerald-50'}
                                        ${lastKeyPressed === 'ArrowDown' && index === selectedIndex ? 'animate-pulse-once' : ''}
                                        ${lastKeyPressed === 'ArrowUp' && index === selectedIndex ? 'animate-pulse-once' : ''}`}
                                >
                                    <div className="flex justify-between items-start">
                                        <div className="flex-1">
                                            <div className="font-medium text-gray-900">
                                                {highlightMatch(medicine.name, searchQuery)}
                                            </div>
                                            <div className="text-xs text-gray-500 mt-1">
                                                <span className="px-2 py-1 bg-gray-100 rounded text-sm">
                                                    Salt: {medicine.salt}
                                                </span>
                                                {medicine.brand && (
                                                    <span className="ml-1 px-2 py-1 bg-blue-100 rounded text-sm">
                                                        Brand: {medicine.brand}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </>
                    ) : searchQuery.trim() ? (
                        <div className="px-3 py-4 text-center text-gray-500">
                            <Search className="h-6 w-6 mx-auto mb-2 text-gray-300" />
                            <div className="text-sm">No medicines found</div>
                            <div className="text-xs mt-1">
                                Try searching for &quot;{searchQuery}&quot; or check spelling
                            </div>
                        </div>
                    ) : (
                        <div className="px-3 py-4 text-center text-gray-500">
                            <Search className="h-6 w-6 mx-auto mb-2 text-gray-300" />
                            <div className="text-sm">Start typing to search medicines</div>
                            <div className="text-xs mt-2 space-y-1 text-gray-400">
                                <div>Press ↓ to navigate suggestions</div>
                                <div>Press Enter to select</div>
                                <div>Press Esc to close</div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};