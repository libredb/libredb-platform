-- CreateTable
CREATE TABLE "platform"."scheduler_runs" (
    "task" TEXT NOT NULL,
    "lastStartedAt" TIMESTAMPTZ(3),
    "lastSucceededAt" TIMESTAMPTZ(3),
    "lastFailedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "lastDurationMs" INTEGER,
    "state" JSONB,

    CONSTRAINT "scheduler_runs_pkey" PRIMARY KEY ("task")
);

