import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react"
import { cn } from "@/shared/lib/utils"
import { Button } from "@/shared/components/ui/button"

function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      role="navigation"
      aria-label="pagination"
      data-slot="pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      {...props}
    />
  )
}

function PaginationContent({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn("flex flex-row items-center gap-1", className)}
      {...props}
    />
  )
}

function PaginationItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="pagination-item" className={cn("", className)} {...props} />
}

function PaginationButton({
  className,
  isActive,
  ...props
}: React.ComponentProps<typeof Button> & {
  isActive?: boolean
}) {
  return (
    <Button
      data-slot="pagination-button"
      data-active={isActive}
      aria-current={isActive ? "page" : undefined}
      variant={isActive ? "default" : "ghost"}
      size="icon-sm"
      className={className}
      {...props}
    />
  )
}

function PaginationPrevious({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="pagination-previous"
      aria-label="Go to previous page"
      variant="ghost"
      size="sm"
      className={cn("gap-1", className)}
      {...props}
    >
      <ChevronLeftIcon />
      <span>Previous</span>
    </Button>
  )
}

function PaginationNext({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="pagination-next"
      aria-label="Go to next page"
      variant="ghost"
      size="sm"
      className={cn("gap-1", className)}
      {...props}
    >
      <span>Next</span>
      <ChevronRightIcon />
    </Button>
  )
}

function PaginationEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      data-slot="pagination-ellipsis"
      className={cn("flex size-8 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontalIcon className="size-4" />
      <span className="sr-only">More pages</span>
    </span>
  )
}

export {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationButton,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
}
