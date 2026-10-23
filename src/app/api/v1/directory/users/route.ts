import { NextResponse } from 'next/server'
import { withBearer } from '@/shared/lib/bearer/with-bearer'
import { parseApiInput } from '@/shared/lib/bearer/api-v1-input'
import { ValidationError } from '@/shared/lib/errors'
import { searchDirectory } from '@/features/connections/lib/grant-service'
import { searchDirectoryUsersSchema } from '@/features/connections/lib/grant.schema'

// One page of the Keycloak users a grant can name, the answer of the grant picker: ?q= is the search text and ?page=
// the page from 1.
export const GET = withBearer(async (user, request) => {
  const query = new URL(request.url).searchParams
  const page = query.get('page')
  let input
  try {
    input = parseApiInput(searchDirectoryUsersSchema, {
      search: query.get('q') ?? undefined,
      page: page === null ? undefined : Number(page === '' ? Number.NaN : page),
    })
  } catch (error) {
    // The schema names the search text `search`, which this route reads from ?q=.
    if (!(error instanceof ValidationError)) throw error
    const { search, ...fieldErrors } = error.fieldErrors
    throw new ValidationError(search === undefined ? fieldErrors : { ...fieldErrors, q: search })
  }
  return NextResponse.json(await searchDirectory(input, user))
})
