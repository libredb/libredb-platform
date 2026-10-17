// Quoting for the SQL and psql text that provisioning renders. Every identifier and literal the installer interpolates
// passes through here, so a quote or a backslash in a value can never end its token early.

/** A double-quoted SQL identifier with every double quote doubled, so `a"b` becomes `"a""b"`. */
export function quoteIdent(name: string): string {
  if (name === "") throw new Error("an SQL identifier must not be empty");
  if (name.includes("\0")) throw new Error("an SQL identifier must not contain a NUL character");
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * A single-quoted SQL literal with every single quote doubled. A value with a backslash becomes an escape string
 * (`E'...'`) with every backslash doubled, as PostgreSQL's quote_literal does, so the literal means the same text
 * whatever standard_conforming_strings is.
 */
export function quoteLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("an SQL literal must not contain a NUL character");
  const quoted = value.replaceAll("'", "''");
  return value.includes("\\") ? `E'${quoted.replaceAll("\\", "\\\\")}'` : `'${quoted}'`;
}

/**
 * A single-quoted argument of a psql meta-command such as `\set`. psql reads a backslash in it as an escape and two
 * single quotes as one, and a meta-command ends at the line break.
 */
export function quotePsqlArgument(value: string): string {
  if (/[\0\n\r]/.test(value)) throw new Error("a psql argument must not contain a NUL character or a line break");
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}
