import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
    "inline-flex items-center justify-center rounded-full px-3 py-1.5 text-sm font-medium w-fit whitespace-nowrap shrink-0 transition-all duration-200",
    {
        variants: {
            variant: {
                default:
                    "border-0 bg-[var(--primary-color)] text-white hover:bg-[var(--primary-color-dark)] shadow-sm",
                secondary:
                    "border border-gray-200 bg-[var(--secondary-color)] text-[var(--text-primary)] hover:bg-gray-200",
                destructive:
                    "border-0 bg-red-500 text-white hover:bg-red-600 shadow-sm",
                outline:
                    "border-2 border-[var(--primary-color)] text-[var(--primary-color)] bg-white hover:bg-[var(--primary-color)] hover:text-white",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    }
)

function Badge({
    className,
    variant,
    asChild = false,
    ...props
}: React.ComponentProps<"span"> &
    VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
    const Comp = asChild ? Slot : "span"

    return (
        <Comp
            data-slot="badge"
            className={cn(badgeVariants({ variant }), className)}
            {...props}
        />
    )
}

export { Badge, badgeVariants }
