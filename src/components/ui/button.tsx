import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
    "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 hover:shadow-md hover:cursor-pointer  active:scale-95",
    {
        variants: {
            variant: {
                default: "bg-[#2563EB] text-white hover:bg-[#1E40AF] shadow-sm hover:shadow-md",
                destructive:
                    "bg-[#DC2626] text-white hover:bg-[#B91C1C] shadow-sm hover:shadow-md",
                outline:
                    "border-2 border-gray-200 bg-white bg-[#F3F4F6]  hover:border-[#2563EB] text-gray-700 hover:text-[#2563EB]",
                secondary:
                    "bg-[#F3F4F6] text-[#111827] hover:bg-gray-200 border border-gray-200",
                ghost: "hover:bg-[#F3F4F6] hover:text-[#2563EB]",
                link: "text-[#2563EB] underline-offset-4 hover:underline hover:text-[#1E40AF]",
            },
            size: {
                default: "h-11 px-6 py-2",
                sm: "h-9 rounded-md px-4 text-sm",
                lg: "h-12 rounded-md px-8 text-base",
                icon: "h-10 w-10",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
)

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
    asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : "button"
        return (
            <Comp
                className={cn(buttonVariants({ variant, size, className }))}
                ref={ref}
                {...props}
            />
        )
    }
)
Button.displayName = "Button"

export { Button, buttonVariants }