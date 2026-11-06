"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type SwitchProps = {
    checked?: boolean;
    defaultChecked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
    className?: string;
    id?: string;
    name?: string;
};

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
    (
        { checked, defaultChecked, onCheckedChange, disabled, className, id, name },
        ref
    ) => {
        const [localChecked, setLocalChecked] = React.useState<boolean>(defaultChecked ?? false);

        React.useEffect(() => {
            if (typeof checked === "boolean") setLocalChecked(checked);
        }, [checked]);

        const toggle = () => {
            if (disabled) return;
            const next = !localChecked;
            if (typeof checked !== "boolean") setLocalChecked(next);
            onCheckedChange?.(next);
        };

        return (
            <button
                type="button"
                role="switch"
                aria-checked={localChecked}
                aria-disabled={disabled}
                onClick={toggle}
                className={cn(
                    "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                    localChecked ? "bg-emerald-600" : "bg-gray-300",
                    disabled && "opacity-50 cursor-not-allowed",
                    className
                )}
            >
                <span
                    className={cn(
                        "inline-block h-5 w-5 transform rounded-full bg-white transition-transform",
                        localChecked ? "translate-x-5" : "translate-x-1"
                    )}
                />
                {/* Hidden input for form compatibility */}
                <input
                    ref={ref}
                    id={id}
                    name={name}
                    type="checkbox"
                    className="sr-only"
                    checked={localChecked}
                    onChange={(e) => onCheckedChange?.(e.target.checked)}
                    disabled={disabled}
                    aria-hidden
                    tabIndex={-1}
                />
            </button>
        );
    }
);
Switch.displayName = "Switch";

export default Switch;
