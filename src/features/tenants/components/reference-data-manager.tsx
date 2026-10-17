'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Button } from '@/shared/components/ui/button'
import { Checkbox } from '@/shared/components/ui/checkbox'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import { PencilIcon, PlusIcon, CheckIcon, XIcon } from 'lucide-react'
import { useAction } from '@/shared/hooks/use-action'
import {
  updateReferenceValue,
  createReferenceValue,
  type UpdateReferenceValueData,
} from '../actions/manage-reference-data'

interface ReferenceTypeItem {
  id: string
  code: string
  name: string
  description: string | null
  category: string | null
  isSystem: boolean
  isActive: boolean
  values: ReferenceValueItem[]
}

interface ReferenceValueItem {
  id: string
  code: string
  name: string
  description: string | null
  translations: Record<string, unknown> | null
  colorCode: string | null
  icon: string | null
  isActive: boolean
  sortOrder: number
}

interface ReferenceDataManagerProps {
  types: ReferenceTypeItem[]
}

interface EditingValue {
  id: string
  name: string
  description: string
  translations: string
  colorCode: string
  icon: string
  isActive: boolean
  sortOrder: number
}

export function ReferenceDataManager({ types }: ReferenceDataManagerProps) {
  const [selectedTypeId, setSelectedTypeId] = useState<string>(
    types[0]?.id ?? '',
  )
  const [editingValueId, setEditingValueId] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  const selectedType = types.find((t) => t.id === selectedTypeId)

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
      {/* Left panel: Type list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Reference Types</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="flex flex-col">
            {types.map((type) => (
              <button
                key={type.id}
                type="button"
                className={`flex flex-col gap-0.5 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 ${
                  type.id === selectedTypeId
                    ? 'border-l-2 border-primary bg-muted/50'
                    : 'border-l-2 border-transparent'
                }`}
                onClick={() => {
                  setSelectedTypeId(type.id)
                  setEditingValueId(null)
                  setShowAddForm(false)
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{type.name}</span>
                  {type.isSystem && (
                    <Badge variant="secondary" className="text-[10px]">
                      System
                    </Badge>
                  )}
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {type.code}
                </span>
              </button>
            ))}
            {types.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No reference types found.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Right panel: Values for selected type */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">
                {selectedType?.name ?? 'Select a type'}
              </CardTitle>
              {selectedType?.description && (
                <p className="text-xs text-muted-foreground">
                  {selectedType.description}
                </p>
              )}
            </div>
            {selectedType && (
              <Button
                size="sm"
                onClick={() => {
                  setShowAddForm(true)
                  setEditingValueId(null)
                }}
              >
                <PlusIcon className="mr-1 size-4" />
                Add Value
              </Button>
            )}
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          {showAddForm && selectedType && (
            <div className="mb-4">
              <AddValueForm
                referenceTypeId={selectedType.id}
                onDone={() => setShowAddForm(false)}
              />
              <Separator className="mt-4" />
            </div>
          )}

          {selectedType ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Color</TableHead>
                  <TableHead>Icon</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedType.values.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="h-24 text-center text-muted-foreground"
                    >
                      No values for this type.
                    </TableCell>
                  </TableRow>
                ) : (
                  selectedType.values.map((val) =>
                    editingValueId === val.id ? (
                      <EditValueRow
                        key={val.id}
                        value={val}
                        onDone={() => setEditingValueId(null)}
                      />
                    ) : (
                      <TableRow key={val.id}>
                        <TableCell className="font-mono text-xs">
                          {val.code}
                        </TableCell>
                        <TableCell className="font-medium">{val.name}</TableCell>
                        <TableCell>
                          {val.colorCode ? (
                            <div className="flex items-center gap-2">
                              <span
                                className="inline-block size-4 rounded-full border"
                                style={{ backgroundColor: val.colorCode }}
                              />
                              <span className="text-xs text-muted-foreground">
                                {val.colorCode}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              --
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {val.icon ?? '--'}
                        </TableCell>
                        <TableCell>
                          {val.isActive ? (
                            <CheckIcon className="size-4 text-green-600" />
                          ) : (
                            <XIcon className="size-4 text-muted-foreground/40" />
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {val.sortOrder}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setEditingValueId(val.id)}
                          >
                            <PencilIcon className="size-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ),
                  )
                )}
              </TableBody>
            </Table>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Select a reference type from the left panel.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function EditValueRow({
  value,
  onDone,
}: {
  value: ReferenceValueItem
  onDone: () => void
}) {
  const { register, handleSubmit, watch, setValue } = useForm<EditingValue>({
    defaultValues: {
      id: value.id,
      name: value.name,
      description: value.description ?? '',
      translations: value.translations
        ? JSON.stringify(value.translations, null, 2)
        : '',
      colorCode: value.colorCode ?? '',
      icon: value.icon ?? '',
      isActive: value.isActive,
      sortOrder: value.sortOrder,
    },
  })

  const { execute, isPending } = useAction(updateReferenceValue, {
    successMessage: 'Value updated',
    onSuccess: () => onDone(),
  })

  const onSubmit = (data: EditingValue) => {
    execute({
      id: data.id,
      name: data.name,
      description: data.description || undefined,
      translations: data.translations || undefined,
      colorCode: data.colorCode || undefined,
      icon: data.icon || undefined,
      isActive: data.isActive,
      sortOrder: Number(data.sortOrder),
    } as unknown as UpdateReferenceValueData)
  }

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{value.code}</TableCell>
      <TableCell>
        <Input {...register('name')} className="h-8 text-sm" />
      </TableCell>
      <TableCell>
        <Input
          {...register('colorCode')}
          className="h-8 w-24 text-sm"
          placeholder="#hex"
        />
      </TableCell>
      <TableCell>
        <Input
          {...register('icon')}
          className="h-8 w-20 text-sm"
          placeholder="icon"
        />
      </TableCell>
      <TableCell>
        <Checkbox
          checked={watch('isActive')}
          onCheckedChange={(checked) => setValue('isActive', !!checked)}
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          {...register('sortOrder', { valueAsNumber: true })}
          className="h-8 w-16 text-sm"
        />
      </TableCell>
      <TableCell>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={isPending}
            onClick={handleSubmit(onSubmit)}
          >
            <CheckIcon className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={onDone}
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

function AddValueForm({
  referenceTypeId,
  onDone,
}: {
  referenceTypeId: string
  onDone: () => void
}) {
  const { register, handleSubmit, formState: { errors } } = useForm({
    defaultValues: {
      code: '',
      name: '',
      description: '',
      colorCode: '',
      icon: '',
      translations: '',
    },
  })

  const { execute, isPending } = useAction(createReferenceValue, {
    successMessage: 'Value created',
    onSuccess: () => onDone(),
  })

  const onSubmit = (data: {
    code: string
    name: string
    description: string
    colorCode: string
    icon: string
    translations: string
  }) => {
    execute({
      referenceTypeId,
      code: data.code,
      name: data.name,
      description: data.description || undefined,
      colorCode: data.colorCode || undefined,
      icon: data.icon || undefined,
      translations: data.translations || undefined,
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <h3 className="text-sm font-semibold">Add New Value</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Code</Label>
          <Input
            {...register('code', { required: 'Required' })}
            className="h-8 text-sm"
            placeholder="UNIQUE_CODE"
          />
          {errors.code && (
            <p className="text-xs text-destructive">{errors.code.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input
            {...register('name', { required: 'Required' })}
            className="h-8 text-sm"
            placeholder="Display name"
          />
          {errors.name && (
            <p className="text-xs text-destructive">{errors.name.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Color Code</Label>
          <Input
            {...register('colorCode')}
            className="h-8 text-sm"
            placeholder="#3b82f6"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Icon</Label>
          <Input
            {...register('icon')}
            className="h-8 text-sm"
            placeholder="icon-name"
          />
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-xs">Translations (JSON)</Label>
          <Input
            {...register('translations')}
            className="h-8 text-sm"
            placeholder='{"en": "English", "tr": "Turkish"}'
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? 'Creating...' : 'Create'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
