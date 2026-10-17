// The seed entry without dotenv: the image's migrate subcommand runs its bundle after `prisma migrate deploy`,
// with DATABASE_URL in pg syntax from the environment (docs/deploy/platform-runtime.md).
// prisma/seed.ts loads .env and .env.local and then runs this file, for development.
import { seedProduction } from './production'
import { parseDeploymentMode } from '../../src/shared/lib/deployment'
import { ConfigError } from '../../src/shared/lib/errors'

async function main() {
  // The development seed creates users and tenants, which a self-hosted install never has.
  if (process.env.SEED_MODE === 'development' && parseDeploymentMode(process.env.DEPLOYMENT_MODE) === 'self-hosted') {
    throw new ConfigError('SEED_MODE=development is not allowed in self-hosted mode: unset SEED_MODE')
  }

  await seedProduction()

  if (process.env.SEED_MODE === 'development') {
    // Loaded only here, so the production seed never loads the development data. The image's bundle leaves it out
    // (`build:migrator` in package.json), so SEED_MODE=development fails there with "Cannot find module".
    const { seedDevelopment } = await import('./development')
    await seedDevelopment()
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
