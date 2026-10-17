// Process exit codes, which installer/README.md lists. Scripts and CI depend on these values, so never renumber them.
export const ExitCode = {
  Ok: 0,
  RuntimeFailure: 1,
  InvalidUsage: 2,
  PreflightFailed: 3,
  VerificationFailed: 4,
  LockHeld: 5,
  UnsafeChangeRefused: 6,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
