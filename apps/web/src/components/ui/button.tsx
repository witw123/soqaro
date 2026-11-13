import * as React from "react"
import { cn } from "@/lib/utils"

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "destructive" | "outline" | "ghost" | "glass"
  size?: "default" | "sm" | "lg" | "icon"
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = "", variant = "default", size = "default", ...props }, ref) => {
    let variantStyles = ""
    if (variant === "default") {
      variantStyles = "bg-accent hover:bg-accent-hover text-white shadow-xs"
    } else if (variant === "destructive") {
      variantStyles = "bg-[var(--red-9)] hover:bg-[var(--red-10)] text-white shadow-xs"
    } else if (variant === "ghost") {
      variantStyles = "hover:bg-surface-hover text-foreground-muted hover:text-foreground"
    } else if (variant === "outline") {
      variantStyles = "border-[0.5px] border-surface-border hover:bg-surface-hover text-foreground"
    } else if (variant === "glass") {
      variantStyles = "glass-button text-foreground-muted hover:text-foreground"
    }

    let sizeStyles = ""
    if (size === "default") {
      sizeStyles = "h-9 px-4 py-2 text-sm"
    } else if (size === "sm") {
      sizeStyles = "h-8 px-3 text-xs"
    } else if (size === "lg") {
      sizeStyles = "h-11 px-6 text-sm rounded-[var(--theme-control-radius,0.5rem)]"
    } else if (size === "icon") {
      sizeStyles = "h-9 w-9 shrink-0 p-0"
    }

    const baseStyles = "inline-flex items-center justify-center rounded-[var(--theme-control-radius,0.5rem)] font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-40 active:scale-[0.98] cursor-pointer"

    return (
      <button
        ref={ref}
        className={cn(baseStyles, variantStyles, sizeStyles, className)}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"
