// prisma/seed.ts
// The development wrapper of the seed: loads .env and .env.local, then runs prisma/seeds/run.ts,
// which the image bundles and runs without dotenv.
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.join(__dirname, '..', '.env') })
dotenv.config({ path: path.join(__dirname, '..', '.env.local'), override: true })

// A dynamic import, because static imports run before this module's body, and the seeds read DATABASE_URL when
// they load.
void import('./seeds/run')
