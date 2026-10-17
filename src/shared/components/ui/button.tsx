"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"

import { cn } from "@/shared/lib/utils"
import { buttonVariants, type ButtonVariantsProps } from "./button-variants"

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & ButtonVariantsProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
