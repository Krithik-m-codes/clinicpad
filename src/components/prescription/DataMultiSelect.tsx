"use client";

import React, { useState, useEffect, useCallback } from "react";
import { MultiSelectDropdown, MultiSelectOption } from "@/components/ui/multi-select";
import {
    complaintsRepository,
    diagnosisRepository,
    medicalHistoryRepository,
    medicinesRepository,
    TestsRepository,
} from "@/lib/db";
import type { Medicine } from "@/lib/db/dbManager";

const testsRepository = TestsRepository.getInstance();

interface DataMultiSelectProps {
    type: "complaints" | "diagnosis" | "medicalHistory" | "tests" | "drugHistory";
    value: string[];
    onChange: (value: string[]) => void;
    placeholder?: string;
    className?: string;
    disabled?: boolean;
}

export function DataMultiSelect({
    type,
    value,
    onChange,
    placeholder,
    className,
    disabled = false,
}: DataMultiSelectProps) {
    const [options, setOptions] = useState<MultiSelectOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(true);
    const pageSize = 20;

    // Use a ref to track the current search timeout
    const searchTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

    const loadData = useCallback(async (searchQuery: string = "", pageNum: number = 1) => {
        try {
            setLoading(true);
            setError(null);

            let data: MultiSelectOption[] = [];
            let response;
            const query = searchQuery.trim();

            switch (type) {
                case "complaints": {
                    response = query
                        ? await complaintsRepository.search(query, pageNum, pageSize)
                        : await complaintsRepository.getAll(pageNum, pageSize);
                    if ('data' in response) {
                        data = response.data.map(item => ({
                            id: item.id?.toString() || `complaint-${item.name}`,
                            name: item.name,
                        }));
                    }
                    break;
                }
                case "diagnosis": {
                    response = query
                        ? await diagnosisRepository.search(query, pageNum, pageSize)
                        : await diagnosisRepository.getAll(pageNum, pageSize);
                    if ('data' in response) {
                        data = response.data.map(item => ({
                            id: item.id?.toString() || `diagnosis-${item.name}`,
                            name: item.name,
                        }));
                    }
                    break;
                }
                case "medicalHistory": {
                    response = query
                        ? await medicalHistoryRepository.search(query, pageNum, pageSize)
                        : await medicalHistoryRepository.getAll(pageNum, pageSize);
                    if ('data' in response) {
                        data = response.data.map(item => ({
                            id: item.id?.toString() || `history-${item.name}`,
                            name: item.name,
                        }));
                    }
                    break;
                }
                case "tests": {
                    response = query
                        ? await testsRepository.searchByName(query, pageNum)
                        : await testsRepository.getAll(pageNum, pageSize);
                    if ('data' in response) {
                        data = response.data.map(item => ({
                            id: item.id?.toString() || `test-${item.name}`,
                            name: item.name,
                        }));
                    }
                    break;
                }
                case "drugHistory": {
                    response = query
                        ? await medicinesRepository.search(query, pageNum, pageSize)
                        : await medicinesRepository.getAll(pageNum, pageSize);
                    if ('data' in response) {
                        data = response.data.map((item: Medicine) => ({
                            id: item.id?.toString() || `drug-${item.name}`,
                            name: item.name,
                            description: [
                                item.salt && `Salt: ${item.salt}`,
                                item.brand && `Brand: ${item.brand}`
                            ].filter(Boolean).join(', ') || undefined
                        }));
                    }
                    break;
                }
            }

            if (pageNum === 1) {
                setOptions(data);
            } else {
                setOptions(prev => [...prev, ...data]);
            }

            setHasMore(data.length === pageSize);
        } catch (err) {
            console.error(`Error loading ${type}:`, err);
            setError(`Failed to load ${type} data`);
        } finally {
            setLoading(false);
        }
    }, [type]);

    // Single search handler with debounce
    const handleSearch = useCallback((query: string) => {
        setSearchTerm(query);

        // Clear previous timeout
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        // Set new timeout for debounced search
        searchTimeoutRef.current = setTimeout(() => {
            setPage(1);
            loadData(query, 1);
        }, 300);
    }, [loadData]);

    const handleLoadMore = useCallback(() => {
        if (!loading && hasMore) {
            const nextPage = page + 1;
            setPage(nextPage);
            loadData(searchTerm, nextPage);
        }
    }, [loading, hasMore, page, searchTerm, loadData]);

    // Initial data load only
    useEffect(() => {
        loadData("", 1);
    }, [loadData]);

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, []);

    // FIXED: Handle MultiSelectDropdown onChange properly
    const handleMultiSelectChange = useCallback((newValue: (string | number)[]) => {
        // Since we're using mode="name", the values should be strings (names)
        // Convert all values to strings to ensure type safety
        const stringValues = newValue.map(v => String(v));
        onChange(stringValues);
    }, [onChange]);

    const getPlaceholder = () => {
        if (placeholder) return placeholder;

        switch (type) {
            case "complaints":
                return "Select patient complaints...";
            case "diagnosis":
                return "Select diagnosis...";
            case "medicalHistory":
                return "Select medical history...";
            case "drugHistory":
                return "Select previous medicines...";
            default:
                return "Select items...";
        }
    };

    const getSearchPlaceholder = () => {
        switch (type) {
            case "complaints":
                return "Search complaints...";
            case "diagnosis":
                return "Search diagnosis...";
            case "medicalHistory":
                return "Search medical history...";
            case "drugHistory":
                return "Search previous medicines...";
            default:
                return "Search...";
        }
    };

    const getEmptyText = () => {
        if (loading) return "Loading...";
        if (error) return error;

        switch (type) {
            case "complaints":
                return "No complaints found. Add them in Manage Data.";
            case "diagnosis":
                return "No diagnosis found. Add them in Manage Data.";
            case "medicalHistory":
                return "No medical history found. Add them in Manage Data.";
            case "drugHistory":
                return "No previous medicines found. They will appear here after prescriptions.";
            default:
                return "No items found.";
        }
    };

    if (loading && options.length === 0) {
        return (
            <div className="w-full h-[40px] border border-gray-300 rounded-md flex items-center justify-center bg-gray-50">
                <span className="text-sm text-gray-500">Loading...</span>
            </div>
        );
    }

    return (
        <MultiSelectDropdown
            mode="name" // This ensures we always work with names
            options={options}
            value={value} // This should be an array of strings (names)
            onChange={handleMultiSelectChange} // Use the fixed handler
            onSearch={handleSearch}
            onLoadMore={handleLoadMore}
            hasMore={hasMore}
            loading={loading}
            placeholder={getPlaceholder()}
            searchPlaceholder={getSearchPlaceholder()}
            emptyText={getEmptyText()}
            className={className}
            disabled={disabled || loading}
        />
    );
}