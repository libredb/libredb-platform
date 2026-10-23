'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { searchDirectoryUsersSchema, type DirectoryUserPage } from '../lib/grant.schema'
import { searchDirectory } from '../lib/grant-service'

/** One page of the Keycloak users the grant picker offers, as searchDirectory describes. */
export const searchDirectoryUsers = safeAction(
  'searchDirectoryUsers',
  searchDirectoryUsersSchema,
  (input, user): Promise<DirectoryUserPage> => searchDirectory(input, user),
)
