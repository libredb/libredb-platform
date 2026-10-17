// Step 4 of the Docker graph: the internal CA under /opt/libredb/tls/ca and one leaf per public hostname
// and for the managed PostgreSQL server, issued when missing, invalid or within 30 days of expiry. A present CA is
// never replaced, also not by `apply --renew-certificates`, which re-issues every leaf. In tls.mode provided the
// customer's chain and key of each public hostname are checked and copied to the edge instead, and in
// tls.mode external the edge needs no certificate. Private keys are registered with the redactor, so no log line can
// carry one.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyDirectory, applyFile, observePath, readOptionalFile } from "../adapters/host-fs";
import { planFile, type FileSpec, type ObservedPath } from "../docker/converge";
import { INTERNAL_CA_FILES, TLS_DIRECTORIES, leafFiles } from "../docker/layout";
import { tlsActions, type TlsAction } from "../docker/tls";
import type { Step } from "../engine/step";
import { INSTALL_ROOT } from "../render/compose";
import { createCa, type CertificateAuthority, type KeyedCertificate } from "../tls/ca";
import { issueLeaf } from "../tls/leaf";
import { desiredTls, planTls, type ObservedTls } from "../tls/plan";
import { loadProvidedTls, providedEndpoints } from "../tls/provided";
import { EDGE_TLS_DIR, edgeLeafFiles } from "../render/caddyfile";
import type { DockerContext } from "./docker-context";

interface TlsObservation extends ObservedTls {
  /** The provided chain and key files on the edge, as the host holds them now. */
  provided: { path: string; observed: ObservedPath | undefined }[];
}

/**
 * The files the edge reads in tls.mode provided: each host's checked chain and its key, which only root reads.
 * A provided certificate that cannot be used is a PreflightError (exit 3).
 */
function providedFiles(context: DockerContext): FileSpec[] {
  const endpoints = providedEndpoints(context.config, context.desired.edge.sites);
  if (endpoints.length === 0) return [];
  const leaves = loadProvidedTls({
    endpoints,
    caBundleFile: context.config.tls.caBundleFile as string,
    readFile: (path) => readFileSync(path, "utf8"),
    now: context.now(),
  });
  return leaves.flatMap((leaf) => {
    context.redactor.register(leaf.keyPem);
    const files = edgeLeafFiles(leaf.host);
    return [
      { path: join(EDGE_TLS_DIR, files.certificate), content: leaf.certPem, mode: 0o644, uid: 0, gid: 0 },
      { path: join(EDGE_TLS_DIR, files.key), content: leaf.keyPem, mode: 0o600, uid: 0, gid: 0 },
    ];
  });
}

function providedPaths(context: DockerContext): string[] {
  return providedEndpoints(context.config, context.desired.edge.sites).flatMap((endpoint) => {
    const files = edgeLeafFiles(endpoint.host);
    return [join(EDGE_TLS_DIR, files.certificate), join(EDGE_TLS_DIR, files.key)];
  });
}

function readKeyed(context: DockerContext, certificate: string, key: string): Partial<KeyedCertificate> {
  const certPem = readOptionalFile(certificate);
  const keyPem = readOptionalFile(key);
  if (keyPem !== undefined) context.redactor.register(keyPem);
  return { ...(certPem === undefined ? {} : { certPem }), ...(keyPem === undefined ? {} : { keyPem }) };
}

function readCa(context: DockerContext): Partial<KeyedCertificate> {
  return readKeyed(context, INTERNAL_CA_FILES.certificate, INTERNAL_CA_FILES.key);
}

function writeKeyed(material: KeyedCertificate, files: { certificate: string; key: string; uid: number; gid: number }) {
  const owner = { uid: files.uid, gid: files.gid };
  applyFile({ path: files.certificate, content: material.certPem, mode: 0o644, ...owner });
  applyFile({ path: files.key, content: material.keyPem, mode: 0o600, ...owner });
}

export const tlsStep: Step<DockerContext, TlsObservation, TlsAction> = {
  name: "tls",
  inputs: ({ config }) => ({ ...desiredTls(config), provided: config.tls.provided ?? null }),
  observe({ context }) {
    const leaves: Record<string, Partial<KeyedCertificate>> = {};
    for (const leaf of desiredTls(context.config).leaves) {
      const files = leafFiles(leaf);
      leaves[leaf.name] = readKeyed(context, files.certificate, files.key);
    }
    const provided = providedPaths(context).map((path) => ({ path, observed: observePath(path) }));
    for (const file of provided) {
      if (file.observed?.kind === "file" && file.path.endsWith(".key")) context.redactor.register(file.observed.content);
    }
    return { ca: readCa(context), leaves, provided };
  },
  plan(observed, { context }) {
    const actions = tlsActions(
      planTls(observed, desiredTls(context.config), context.now(), { renewAll: context.renewCertificates }),
    );
    for (const spec of providedFiles(context)) {
      const found = observed.provided.find((file) => file.path === spec.path);
      actions.push(...planFile(spec, found?.observed));
    }
    return actions;
  },
  async apply(actions, { context }) {
    mkdirSync(INSTALL_ROOT, { recursive: true, mode: 0o755 });
    for (const directory of TLS_DIRECTORIES) applyDirectory(directory);
    let ca: CertificateAuthority;
    if (actions.some((action) => action.kind === "ca")) {
      ca = await createCa({ commonName: desiredTls(context.config).caCommonName, now: context.now() });
      context.redactor.register(ca.keyPem);
      writeKeyed(ca, { ...INTERNAL_CA_FILES, uid: 0, gid: 0 });
    } else {
      const { certPem, keyPem } = readCa(context);
      if (certPem === undefined || keyPem === undefined) throw new Error("the internal CA disappeared during the run");
      ca = { certPem, keyPem };
    }
    for (const action of actions) {
      if (action.kind === "file") {
        applyFile(action.file);
      } else if (action.kind === "leaf") {
        const leaf = await issueLeaf(ca, action.leaf.hosts, context.now());
        context.redactor.register(leaf.keyPem);
        writeKeyed(leaf, leafFiles(action.leaf));
      }
    }
  },
};
