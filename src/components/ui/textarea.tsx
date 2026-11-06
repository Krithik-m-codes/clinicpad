import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
    return (
        <textarea
            data-slot="textarea"
            className={cn(
                "flex min-h-[120px] w-full rounded-md border-2 border-gray-200 bg-white px-4 py-3 text-sm font-medium",
                "placeholder:text-gray-500 placeholder:font-normal",
                "focus-visible:outline-none focus-visible:border-[var(--primary-color)] focus-visible:ring-2 focus-visible:ring-[var(--primary-color)]/20",
                "hover:border-gray-300 transition-all duration-200",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-50",
                "resize-none leading-relaxed",
                className
            )}
            {...props}
        />
    )
}

export { Textarea }
