-- CreateEnum
CREATE TYPE "platform"."AdminActionChannel" AS ENUM ('web', 'api');

-- AlterTable
ALTER TABLE "platform"."admin_actions" ADD COLUMN     "channel" "platform"."AdminActionChannel" NOT NULL DEFAULT 'web';

