import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../../src/cli/main";
import { CATALOGUE } from "../../../src/verify/catalogue";
import { USER_MANAGER_ROLES } from "../../../src/keycloak/desired";

const CHECKLIST = readFileSync(join(import.meta.dir, "../../../docs/ACCEPTANCE.md"), "utf8");
const LINES = CHECKLIST.split("\n");
const REPOSITORY = join(import.meta.dir, "../../../..");
/** The Docker install guide and the upgrade runbook, whose commands an operator copies as they stand. */
const GUIDES = ["docs/deploy/install-docker.md", "installer/docs/runbooks/upgrade.md"];
// An option no command accepts: every command stops at its usage when it reaches it, except version, which ignores its
// arguments, so no probe touches the host.
const UNKNOWN_OPTION = "--acceptance-unknown-option";
// A shell word, made of quoted strings, placeholders such as <dir> and other characters, or an operator that ends the
// command: a pipe, ; or &, or a redirection with its optional file descriptor, such as 2> or <.
const SHELL_TOKEN = /(?<operator>\d*>|<(?![^<>\s]*>)|[|;&])|(?<word>(?:"[^"]*"|'[^']*'|<[^<>\s]*>|[^\s"'|;&<>])+)/g;

/** The sign-off lines, `- [ ] Sign-off <id>: <statement> Name: ... Date: ...`, by id. */
const SIGN_OFFS = new Map(
  LINES.flatMap((line) => {
    const match = /^- \[ \] Sign-off ([A-Z0-9]+): (.+ Date: _+)$/.exec(line);
    return match === null ? [] : [[match[1] ?? "", match[2] ?? ""] as const];
  }),
);

/** The lines of each `## ` section, by its heading. */
function sections(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of LINES) {
    if (line.startsWith("## ")) {
      current = [];
      result.set(line.slice(3), current);
    } else {
      current?.push(line);
    }
  }
  return result;
}

/** The code of a document: every fenced block and every inline code span. */
function codeOf(markdown: string): string[] {
  const code: string[] = [];
  const prose = markdown.replace(/^```[a-z]*\n([\s\S]*?)^```$/gm, (_, block: string) => {
    code.push(block);
    return "";
  });
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) code.push(match[1] ?? "");
  return code;
}

/** Each libredb-installer invocation in a document's code as its words, unquoted, up to an operator or a comment. */
function installerInvocations(markdown: string): string[][] {
  const invocations: string[][] = [];
  for (const code of codeOf(markdown)) {
    for (const match of code.replaceAll("\\\n", " ").matchAll(/(?:^|[\s/])libredb-installer(?:-linux-(?:x64|arm64))?[ \t]+([a-z].*)/gm)) {
      const words: string[] = [];
      for (const token of (match[1] ?? "").matchAll(SHELL_TOKEN)) {
        const word = token.groups?.word;
        if (word === undefined || word.startsWith("#")) break;
        words.push(word.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
      }
      invocations.push(words);
    }
  }
  return invocations;
}

async function run(argv: string[]): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const code = await main(argv, { stdout: () => {}, stderr: (text) => (stderr += text) });
  return { code, stderr };
}

/** Expects a registered command, and a registered subcommand when the command has subcommands, and returns them. */
async function expectRegisteredCommand(args: readonly string[]): Promise<string[]> {
  const command = args[0] ?? "";
  const probe = await run([command, UNKNOWN_OPTION]);
  expect(probe.stderr, `libredb-installer ${command}`).not.toContain(`unknown command '${command}'`);
  if (!probe.stderr.includes(`unknown subcommand '${UNKNOWN_OPTION}'`)) return [command];
  const subcommand = args[1] ?? "";
  const nested = await run([command, subcommand, UNKNOWN_OPTION]);
  expect(nested.stderr, `libredb-installer ${command} ${subcommand}`).not.toContain(`unknown subcommand '${subcommand}'`);
  expect(nested.code).toBe(2);
  return [command, subcommand];
}

describe("installer/docs/ACCEPTANCE.md", () => {
  test("every requirement R1 to R11 has a checklist section", () => {
    const all = sections();
    for (let index = 1; index <= 11; index += 1) {
      const id = `R${index}`;
      const heading = [...all.keys()].find((name) => name.startsWith(`${id} `));
      expect(heading, `a section headed "## ${id} ..."`).toBeDefined();
      const body = (all.get(heading ?? "") ?? []).join("\n");
      expect(body, `${id} states its requirement`).toContain("**Requirement:**");
      expect(body, `${id} gives a command or UI step`).toMatch(/\*\*(Command|UI step|Command and UI step|Procedure):\*\*/);
      expect(body, `${id} gives the expected observation`).toContain("**Expected:**");
      expect(body, `${id} has its sign-off line`).toContain(`- [ ] Sign-off ${id}: `);
      expect(SIGN_OFFS.has(id)).toBe(true);
    }
  });

  test("every libredb-installer command in the checklist is a registered CLI command", async () => {
    const invocations = installerInvocations(CHECKLIST);
    const commands = new Set(invocations.map((args) => args[0]));
    // The commands an on-site acceptance runs, at least.
    for (const expected of ["version", "images", "verify", "status", "preflight", "plan", "apply", "db-shell", "keycloak", "tls"]) {
      expect(commands).toContain(expected);
    }
    for (const args of invocations) await expectRegisteredCommand(args);
  });

  test("every check id in the checklist exists in the verify catalogue", () => {
    const catalogue = new Set(CATALOGUE.map((check) => check.id));
    const cited = LINES.filter((line) => line.startsWith("**Verify checks:** ")).flatMap((line) =>
      [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""),
    );
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(catalogue, `check id ${id}`).toContain(id);
    // The checks cited in prose, such as the warning check admin-mfa, exist as well.
    for (const id of ["admin-mfa", "studio-canary", "edge-tls", "no-proxy"]) {
      expect(CHECKLIST).toContain(`\`${id}\``);
      expect(catalogue).toContain(id);
    }
  });

  test("the checklist has sign-off lines for the Keycloak management roles and for MFA on every account that holds libredb:admin or manage-users", () => {
    const roles = SIGN_OFFS.get("ROLES");
    expect(roles).toBeDefined();
    expect(roles).toContain("the only Keycloak account that holds a realm-management role is the user manager");
    for (const role of USER_MANAGER_ROLES) expect(roles).toContain(role);
    expect(roles).toContain("an account of the customer's identity team");

    const mfa = SIGN_OFFS.get("H1");
    expect(mfa).toBeDefined();
    expect(mfa).toContain("MFA is enforced for every account that holds libredb:admin or manage-users");
    expect(mfa).toContain("`admin-mfa` reported `passed`");

    // The other required hardening has its own sign-off line.
    expect(SIGN_OFFS.get("H2")).toContain("keyring");
    expect(SIGN_OFFS.get("H3")).toContain("MIGRATE_DATABASE_URL");
    expect(SIGN_OFFS.get("H4")).toContain("AUTH_SECRET, JWT_SECRET and every seal key are distinct");
    // R6 is checked on the installed image.
    expect(CHECKLIST).toContain(`docker run --rm --entrypoint node "$PLATFORM_IMAGE" -e "require.resolve('@libredb/studio')"`);
    expect(SIGN_OFFS.get("R6")).toContain("MODULE_NOT_FOUND");
  });
});

for (const guide of GUIDES) {
  describe(guide, () => {
    test("every libredb-installer command is a registered CLI command that accepts each of its options and values", async () => {
      const invocations = installerInvocations(readFileSync(join(REPOSITORY, guide), "utf8"));
      expect(invocations.length).toBeGreaterThan(0);
      for (const args of invocations) {
        const command = await expectRegisteredCommand(args);
        // A command reads its arguments in order, so followed by the unknown option the invocation answers as the
        // command alone does only when the command accepted every word of the invocation.
        expect(await run([...args, UNKNOWN_OPTION]), `libredb-installer ${args.join(" ")}`).toEqual(await run([...command, UNKNOWN_OPTION]));
      }
    });
  });
}
