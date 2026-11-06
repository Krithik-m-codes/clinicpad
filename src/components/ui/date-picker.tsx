"use client"

import * as React from "react"
import { format, isValid, parseISO, startOfDay, startOfToday } from "date-fns"
import { Calendar as CalendarIcon, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calender"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"

export interface DatePickerProps {
    value?: string
    onChange: (value: string) => void
    placeholder?: string
    disabled?: boolean
    className?: string
    wrapperClassName?: string
    minDate?: Date
    maxDate?: Date
    allowClear?: boolean
}

export function DatePicker({
    value,
    onChange,
    placeholder = "Pick a date",
    disabled = false,
    className,
    wrapperClassName,
    minDate,
    maxDate,
    allowClear = true,
}: DatePickerProps) {
    const [open, setOpen] = React.useState(false)

    const selectedDate = React.useMemo(() => {
        if (!value) return undefined
        const parsed = parseISO(value)
        if (!isValid(parsed)) return undefined
        return startOfDay(parsed)
    }, [value])

    const today = React.useMemo(() => startOfToday(), [])
    const effectiveMinDate = React.useMemo(() => startOfDay(minDate ?? today), [minDate, today])
    const effectiveMaxDate = React.useMemo(() => (maxDate ? startOfDay(maxDate) : undefined), [maxDate])

    const isDateDisabled = React.useCallback(
        (date: Date) => {
            const comparison = startOfDay(date)
            if (comparison < effectiveMinDate) return true
            if (effectiveMaxDate && comparison > effectiveMaxDate) return true
            return false
        },
        [effectiveMinDate, effectiveMaxDate]
    )

    const handleSelect = React.useCallback(
        (date?: Date) => {
            if (!date) {
                if (allowClear) {
                    onChange("")
                }
                return
            }

            const normalized = startOfDay(date)
            if (isDateDisabled(normalized)) return

            onChange(format(normalized, "yyyy-MM-dd"))
            setOpen(false)
        },
        [allowClear, isDateDisabled, onChange]
    )

    const handleClear = React.useCallback(() => {
        onChange("")
        setOpen(false)
    }, [onChange])

    return (
        <div className={cn("relative w-full", wrapperClassName)}>
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={disabled}
                        data-empty={!selectedDate}
                        className={cn(
                            "w-full h-11 justify-start text-left font-medium bg-white text-gray-900 border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50/60 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 transition-all gap-3 pr-10 cursor-pointer",
                            "data-[empty=true]:text-muted-foreground",
                            disabled && "opacity-60 cursor-not-allowed",
                            className
                        )}
                    >
                        <CalendarIcon className="h-4 w-4 text-indigo-500" />
                        {selectedDate ? (
                            <span>{format(selectedDate, "PPP")}</span>
                        ) : (
                            <span className="text-sm">{placeholder}</span>
                        )}
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 mt-2 border border-gray-200 shadow-xl bg-white rounded-lg min-h-[340px] flex items-start" align="start">
                    <Calendar
                        mode="single"
                        selected={selectedDate}
                        defaultMonth={selectedDate ?? effectiveMinDate}
                        onSelect={handleSelect}
                        disabled={isDateDisabled}
                        initialFocus
                    />
                </PopoverContent>
            </Popover>

            {allowClear && selectedDate && !disabled && (
                <button
                    type="button"
                    aria-label="Clear selected date"
                    onClick={handleClear}
                    className="absolute inset-y-0 right-2 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 w-7 h-7 mt-[2px] transition-colors"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
    )
}