import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    ({ className, type, ...props }, ref) => {
        return (
            <input
                type={type}
                className={cn(
                    "flex h-11 w-full rounded-md border-2 border-gray-200 bg-white px-4 py-3 text-sm font-medium",
                    "placeholder:text-gray-500 placeholder:font-normal",
                    "focus-visible:outline-none focus-visible:border-[var(--primary-color)] focus-visible:ring-2 focus-visible:ring-[var(--primary-color)]/20",
                    "hover:border-gray-300 transition-all duration-200",
                    "disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-50",
                    "file:border-0 file:bg-transparent file:text-sm file:font-medium",
                    className
                )}
                ref={ref}
                {...props}
            />
        )
    }
)
Input.displayName = "Input"

export { Input }