"use client"

import * as React from "react"
import {
  type Column,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { ArrowUpDown } from "lucide-react"

import { Button } from "@/shared/components/ui/button"
import { Input } from "@/shared/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table"
import { Skeleton } from "@/shared/components/ui/skeleton"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationButton,
  PaginationPrevious,
  PaginationNext,
} from "@/shared/components/ui/pagination"

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  searchKey?: string
  globalSearch?: boolean
  searchPlaceholder?: string
  isLoading?: boolean
  emptyState?: React.ReactNode
  toolbar?: React.ReactNode
  onRowClick?: (row: TData) => void
  pageSize?: number
}

export function DataTable<TData, TValue>({
  columns,
  data,
  searchKey,
  globalSearch = false,
  searchPlaceholder = "Search...",
  isLoading = false,
  emptyState,
  toolbar,
  onRowClick,
  pageSize = 10,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = React.useState("")

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    state: { sorting, columnFilters, globalFilter },
    initialState: { pagination: { pageSize } },
  })

  const pageCount = table.getPageCount()
  const currentPage = table.getState().pagination.pageIndex

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        {globalSearch ? (
          <Input
            placeholder={searchPlaceholder}
            value={globalFilter}
            onChange={(event) => setGlobalFilter(event.target.value)}
            className="max-w-xs"
          />
        ) : searchKey ? (
          <Input
            placeholder={searchPlaceholder}
            value={(table.getColumn(searchKey)?.getFilterValue() as string) ?? ""}
            onChange={(event) =>
              table.getColumn(searchKey)?.setFilterValue(event.target.value)
            }
            className="max-w-xs"
          />
        ) : null}
        {toolbar && <div className="flex items-center gap-3 ml-auto">{toolbar}</div>}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  {columns.map((_, j) => (
                    <TableCell key={`skeleton-${i}-${j}`}>
                      <Skeleton className="h-4 w-full rounded" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={onRowClick ? "cursor-pointer" : undefined}
                  onClick={() => onRowClick?.(row.original)}
                  {...(onRowClick ? {
                    tabIndex: 0,
                    role: "button" as const,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onRowClick(row.original)
                      }
                    }
                  } : {})}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {emptyState ?? "No results."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {currentPage + 1} of {pageCount}
          </p>
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                />
              </PaginationItem>
              {Array.from({ length: Math.min(pageCount, 5) }).map((_, i) => {
                let pageIndex: number
                if (pageCount <= 5) {
                  pageIndex = i
                } else if (currentPage < 3) {
                  pageIndex = i
                } else if (currentPage > pageCount - 4) {
                  pageIndex = pageCount - 5 + i
                } else {
                  pageIndex = currentPage - 2 + i
                }
                return (
                  <PaginationItem key={pageIndex}>
                    <PaginationButton
                      isActive={currentPage === pageIndex}
                      onClick={() => table.setPageIndex(pageIndex)}
                    >
                      {pageIndex + 1}
                    </PaginationButton>
                  </PaginationItem>
                )
              })}
              <PaginationItem>
                <PaginationNext
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </div>
  )
}

/** Helper to create sortable column headers */
export function SortableHeader<TData>({ column, children }: { column: Column<TData, unknown>; children: React.ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 font-medium text-xs uppercase tracking-wider"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {children}
      <ArrowUpDown className="ml-1.5 size-3" />
    </Button>
  )
}
