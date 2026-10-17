import { z } from 'zod'

export const inviteUserSchema = z.object({
  email: z.string().email('Invalid email'),
  roleId: z.string().min(1, 'Role is required'),
})

export const updateUserRoleSchema = z.object({
  membershipId: z.string(),
  roleId: z.string(),
})

export const toggleUserActiveSchema = z.object({
  membershipId: z.string(),
  active: z.boolean(),
})

export type InviteUserData = z.infer<typeof inviteUserSchema>
export type UpdateUserRoleData = z.infer<typeof updateUserRoleSchema>
export type ToggleUserActiveData = z.infer<typeof toggleUserActiveSchema>
