import { describe, expect, test } from 'bun:test';

import {
  PUBLIC_BETA_ARTIFACT_MEDIA_TYPES,
  PUBLIC_BETA_ARTIFACT_NAMES,
  computePublicBetaArtifactManifestDigest,
  parsePublicBetaArtifactManifest,
  parsePublicBetaCycloneDxSbom,
  verifyPublicBetaArtifactManifest,
  verifyPublicBetaDsseProvenance,
} from './public-beta-artifacts';

const COMMIT = 'a'.repeat(40);
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const DIGEST_C = `sha256:${'c'.repeat(64)}` as const;

function repeatedHexDigest(value: number): `sha256:${string}` {
  return `sha256:${(value % 16).toString(16).repeat(64)}`;
}

function manifest() {
  const artifacts = PUBLIC_BETA_ARTIFACT_NAMES.map((name, index) => ({
    name,
    digest: repeatedHexDigest(index + 1),
    sbomDigest: repeatedHexDigest(index + 9),
    provenanceDigest: repeatedHexDigest(index + 5),
    mediaType: PUBLIC_BETA_ARTIFACT_MEDIA_TYPES[name],
  }));
  const value = { schemaVersion: 1 as const, commit: COMMIT, artifacts, manifestDigest: DIGEST_A };
  return { ...value, manifestDigest: computePublicBetaArtifactManifestDigest(value) };
}

function verifiers() {
  return {
    verifyArtifact: () => true,
    verifySbom: () => true,
    verifyProvenance: () => true,
  };
}

function cycloneDxSbom() {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'container',
        name: 'web',
        version: COMMIT,
        'bom-ref': `urn:openopc:artifact:web@${DIGEST_A}`,
        hashes: [{ alg: 'SHA-256', content: DIGEST_A.slice('sha256:'.length) }],
      },
    },
    components: [
      {
        type: 'library',
        name: 'react',
        version: '19.0.0',
        purl: 'pkg:npm/react@19.0.0',
        'bom-ref': 'pkg:npm/react@19.0.0',
        hashes: [{ alg: 'SHA-256', content: 'd'.repeat(64) }],
      },
    ],
    dependencies: [{ ref: 'pkg:npm/react@19.0.0', dependsOn: [] }],
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('NON_JSON_VALUE');
}

function provenanceEnvelope() {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'web', digest: { sha256: DIGEST_A.slice('sha256:'.length) } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://openopc.dev/buildtypes/public-beta/v1',
        externalParameters: {
          artifactName: 'web',
          commit: COMMIT,
          sbomDigest: DIGEST_B,
        },
        internalParameters: {},
        resolvedDependencies: [
          {
            uri: `git+https://github.com/maheshenga/openopc@${COMMIT}`,
            digest: { gitCommit: COMMIT },
          },
        ],
      },
      runDetails: {
        builder: {
          id: 'https://github.com/maheshenga/openopc/.github/workflows/openopc-public-beta-gates.yml@refs/heads/staging',
        },
        metadata: {
          invocationId: 'https://github.com/maheshenga/openopc/actions/runs/1001/attempts/1',
          startedOn: '2026-07-28T10:00:00.000Z',
          finishedOn: '2026-07-28T10:05:00.000Z',
        },
      },
    },
  };
  return {
    statement,
    envelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(canonicalJson(statement), 'utf8').toString('base64'),
      signatures: [
        { keyid: 'openopc-public-beta-sigstore', sig: Buffer.from('signature').toString('base64') },
      ],
    },
  };
}

describe('public beta artifact manifest', () => {
  test('names every independently deployed worker artifact', () => {
    expect(PUBLIC_BETA_ARTIFACT_NAMES).toEqual([
      'web',
      'admin',
      'api',
      'module-host',
      'studio-worker',
      'developer-trust-worker',
      'automation-browser-worker',
      'module-ledger-worker',
      'wasi-runner',
      'oci-runner',
      'desktop',
    ]);
    expect(PUBLIC_BETA_ARTIFACT_NAMES).not.toContain('worker');
  });

  test('uses distinct media types for images, Linux services, and the Windows updater', () => {
    expect(PUBLIC_BETA_ARTIFACT_MEDIA_TYPES.web).toBe(
      'application/vnd.oci.image.manifest.v1+json',
    );
    expect(PUBLIC_BETA_ARTIFACT_MEDIA_TYPES['wasi-runner']).toBe(
      'application/vnd.openopc.linux-service-bundle.v1+zstd',
    );
    expect(PUBLIC_BETA_ARTIFACT_MEDIA_TYPES['oci-runner']).toBe(
      'application/vnd.openopc.linux-service-bundle.v1+zstd',
    );
    expect(PUBLIC_BETA_ARTIFACT_MEDIA_TYPES.desktop).toBe(
      'application/vnd.openopc.windows-update-bundle.v1+zstd',
    );
  });

  test('binds a deterministic CycloneDX 1.6 SBOM to its artifact and commit', () => {
    const sbom = cycloneDxSbom();

    expect(
      parsePublicBetaCycloneDxSbom(sbom, {
        artifactName: 'web',
        artifactDigest: DIGEST_A,
        commit: COMMIT,
      }),
    ).toEqual(sbom);
  });

  test('rejects a CycloneDX SBOM bound to the wrong artifact subject', () => {
    const sbom = cycloneDxSbom();
    sbom.metadata.component.name = 'admin';

    expect(() =>
      parsePublicBetaCycloneDxSbom(sbom, {
        artifactName: 'web',
        artifactDigest: DIGEST_A,
        commit: COMMIT,
      }),
    ).toThrow('PUBLIC_BETA_SBOM_SUBJECT_MISMATCH');
  });

  test('rejects a CycloneDX SBOM with a dangling dependency reference', () => {
    const sbom = cycloneDxSbom();
    sbom.dependencies[0].dependsOn = ['pkg:npm/missing@1.0.0'];

    expect(() =>
      parsePublicBetaCycloneDxSbom(sbom, {
        artifactName: 'web',
        artifactDigest: DIGEST_A,
        commit: COMMIT,
      }),
    ).toThrow('PUBLIC_BETA_SBOM_DEPENDENCY_INVALID');
  });

  test('binds a signed DSSE in-toto provenance statement to the build subject', () => {
    const { envelope, statement } = provenanceEnvelope();
    let pae = '';

    expect(
      verifyPublicBetaDsseProvenance(envelope, {
        artifactName: 'web',
        artifactDigest: DIGEST_A,
        sbomDigest: DIGEST_B,
        commit: COMMIT,
        repository: 'maheshenga/openopc',
        builderId:
          'https://github.com/maheshenga/openopc/.github/workflows/openopc-public-beta-gates.yml@refs/heads/staging',
        verifySignature: (_value, preAuthEncoding) => {
          pae = new TextDecoder().decode(preAuthEncoding);
          return true;
        },
      }),
    ).toEqual(statement);
    expect(pae.startsWith('DSSEv1 ')).toBe(true);
  });

  test('fails closed when the DSSE signature verifier is missing', () => {
    const { envelope } = provenanceEnvelope();

    expect(() =>
      verifyPublicBetaDsseProvenance(envelope, {
        artifactName: 'web',
        artifactDigest: DIGEST_A,
        sbomDigest: DIGEST_B,
        commit: COMMIT,
        repository: 'maheshenga/openopc',
        builderId:
          'https://github.com/maheshenga/openopc/.github/workflows/openopc-public-beta-gates.yml@refs/heads/staging',
      }),
    ).toThrow('PUBLIC_BETA_PROVENANCE_SIGNATURE_VERIFIER_REQUIRED');
  });

  test('rejects an asynchronous DSSE signature adapter instead of trusting its Promise', () => {
    const { envelope } = provenanceEnvelope();

    expect(() =>
      verifyPublicBetaDsseProvenance(envelope, {
        artifactName: 'web',
        artifactDigest: DIGEST_A,
        sbomDigest: DIGEST_B,
        commit: COMMIT,
        repository: 'maheshenga/openopc',
        builderId:
          'https://github.com/maheshenga/openopc/.github/workflows/openopc-public-beta-gates.yml@refs/heads/staging',
        verifySignature: (() => Promise.resolve(false)) as unknown as () => boolean,
      }),
    ).toThrow('PUBLIC_BETA_PROVENANCE_SIGNATURE_INVALID');
  });

  test('rejects a semantically valid but non-canonical DSSE payload', () => {
    const { envelope, statement } = provenanceEnvelope();
    envelope.payload = Buffer.from(JSON.stringify(statement), 'utf8').toString('base64');

    expect(() =>
      verifyPublicBetaDsseProvenance(envelope, {
        artifactName: 'web',
        artifactDigest: DIGEST_A,
        sbomDigest: DIGEST_B,
        commit: COMMIT,
        repository: 'maheshenga/openopc',
        builderId:
          'https://github.com/maheshenga/openopc/.github/workflows/openopc-public-beta-gates.yml@refs/heads/staging',
        verifySignature: () => true,
      }),
    ).toThrow('PUBLIC_BETA_DSSE_PAYLOAD_NOT_CANONICAL');
  });

  test('keeps invalid canonical JSON inside the DSSE payload boundary', () => {
    const { envelope, statement } = provenanceEnvelope();
    statement.predicate.buildDefinition.externalParameters.artifactName = '\ud800';
    envelope.payload = Buffer.from(canonicalJson(statement), 'utf8').toString('base64');

    expect(() =>
      verifyPublicBetaDsseProvenance(envelope, {
        artifactName: 'web',
        artifactDigest: DIGEST_A,
        sbomDigest: DIGEST_B,
        commit: COMMIT,
        repository: 'maheshenga/openopc',
        builderId:
          'https://github.com/maheshenga/openopc/.github/workflows/openopc-public-beta-gates.yml@refs/heads/staging',
        verifySignature: () => true,
      }),
    ).toThrow('PUBLIC_BETA_DSSE_PAYLOAD_NOT_CANONICAL');
  });

  test('rejects signed provenance for the wrong artifact subject', () => {
    const { envelope, statement } = provenanceEnvelope();
    statement.subject[0].digest.sha256 = 'd'.repeat(64);
    envelope.payload = Buffer.from(canonicalJson(statement), 'utf8').toString('base64');

    expect(() =>
      verifyPublicBetaDsseProvenance(envelope, {
        artifactName: 'web',
        artifactDigest: DIGEST_A,
        sbomDigest: DIGEST_B,
        commit: COMMIT,
        repository: 'maheshenga/openopc',
        builderId:
          'https://github.com/maheshenga/openopc/.github/workflows/openopc-public-beta-gates.yml@refs/heads/staging',
        verifySignature: () => true,
      }),
    ).toThrow('PUBLIC_BETA_PROVENANCE_STATEMENT_INVALID');
  });

  test('locks the JSON Schema to the canonical artifact names and digest fields', async () => {
    const schema = (await Bun.file('tests/public-beta/release-artifacts.schema.json').json()) as {
      additionalProperties?: boolean;
      properties?: {
        artifacts?: {
          minItems?: number;
          maxItems?: number;
          allOf?: Array<Record<string, unknown>>;
          items?: {
            additionalProperties?: boolean;
            required?: string[];
            properties?: { name?: { enum?: string[] } };
          };
        };
      };
    };
    const artifacts = schema.properties?.artifacts;
    expect(schema.additionalProperties).toBe(false);
    expect(artifacts?.minItems).toBe(PUBLIC_BETA_ARTIFACT_NAMES.length);
    expect(artifacts?.maxItems).toBe(PUBLIC_BETA_ARTIFACT_NAMES.length);
    expect(artifacts?.items?.additionalProperties).toBe(false);
    expect(artifacts?.items?.required).toEqual([
      'name',
      'digest',
      'sbomDigest',
      'provenanceDigest',
      'mediaType',
    ]);
    expect(artifacts?.items?.properties?.name?.enum).toEqual([...PUBLIC_BETA_ARTIFACT_NAMES]);
    const lockedNames = (artifacts?.allOf ?? []).flatMap((rule) => {
      const contains = rule.contains as { properties?: { name?: { const?: string } } } | undefined;
      return contains?.properties?.name?.const ? [contains.properties.name.const] : [];
    });
    expect(lockedNames).toEqual([...PUBLIC_BETA_ARTIFACT_NAMES]);
    expect(
      (artifacts?.allOf ?? []).every(
        (rule) => rule.minContains === 1 && rule.maxContains === 1,
      ),
    ).toBe(true);
  });

  test('locks each artifact role to its declared media type in JSON Schema', async () => {
    const schema = (await Bun.file('tests/public-beta/release-artifacts.schema.json').json()) as {
      properties?: {
        artifacts?: {
          allOf?: Array<{
            contains?: {
              required?: string[];
              properties?: {
                name?: { const?: string };
                mediaType?: { const?: string };
              };
            };
          }>;
        };
      };
    };
    const rules = schema.properties?.artifacts?.allOf ?? [];
    const mediaTypes = Object.fromEntries(
      rules.map((rule) => [
        rule.contains?.properties?.name?.const,
        rule.contains?.properties?.mediaType?.const,
      ]),
    );

    expect(mediaTypes).toEqual(PUBLIC_BETA_ARTIFACT_MEDIA_TYPES);
    expect(
      rules.every(
        (rule) =>
          rule.contains?.required?.includes('name') === true &&
          rule.contains.required.includes('mediaType'),
      ),
    ).toBe(true);
  });

  test('requires every independent release artifact exactly once', () => {
    const parsed = parsePublicBetaArtifactManifest(manifest());
    expect(parsed.artifacts.map((item) => item.name)).toEqual([...PUBLIC_BETA_ARTIFACT_NAMES]);

    const missing = manifest();
    missing.artifacts = missing.artifacts.slice(1);
    expect(() => parsePublicBetaArtifactManifest(missing)).toThrow(
      'PUBLIC_BETA_ARTIFACT_SET_INCOMPLETE',
    );

    const duplicate = manifest();
    duplicate.artifacts[1] = { ...duplicate.artifacts[0] };
    duplicate.manifestDigest = computePublicBetaArtifactManifestDigest(duplicate);
    expect(() => parsePublicBetaArtifactManifest(duplicate)).toThrow(
      'PUBLIC_BETA_ARTIFACT_SET_INCOMPLETE',
    );
  });

  test('rejects one payload digest relabeled as multiple artifact roles', () => {
    const duplicate = manifest();
    duplicate.artifacts[1].digest = duplicate.artifacts[0].digest;
    duplicate.manifestDigest = computePublicBetaArtifactManifestDigest(duplicate);

    expect(() => parsePublicBetaArtifactManifest(duplicate)).toThrow(
      'PUBLIC_BETA_ARTIFACT_DIGEST_REUSED',
    );
  });

  test('rejects one SBOM digest reused across artifact roles', () => {
    const duplicate = manifest();
    duplicate.artifacts[1].sbomDigest = duplicate.artifacts[0].sbomDigest;
    duplicate.manifestDigest = computePublicBetaArtifactManifestDigest(duplicate);

    expect(() => parsePublicBetaArtifactManifest(duplicate)).toThrow(
      'PUBLIC_BETA_SBOM_DIGEST_REUSED',
    );
  });

  test('rejects one provenance digest reused across artifact roles', () => {
    const duplicate = manifest();
    duplicate.artifacts[1].provenanceDigest = duplicate.artifacts[0].provenanceDigest;
    duplicate.manifestDigest = computePublicBetaArtifactManifestDigest(duplicate);

    expect(() => parsePublicBetaArtifactManifest(duplicate)).toThrow(
      'PUBLIC_BETA_PROVENANCE_DIGEST_REUSED',
    );
  });

  test('rejects an OCI image relabeled as the desktop artifact', () => {
    const relabeled = manifest();
    const desktop = relabeled.artifacts.find((artifact) => artifact.name === 'desktop');
    if (!desktop) throw new Error('TEST_DESKTOP_ARTIFACT_MISSING');
    desktop.mediaType = 'application/vnd.oci.image.manifest.v1+json';
    relabeled.manifestDigest = computePublicBetaArtifactManifestDigest(relabeled);

    expect(() => parsePublicBetaArtifactManifest(relabeled)).toThrow(
      'PUBLIC_BETA_ARTIFACT_MEDIA_TYPE_MISMATCH',
    );
  });

  test('binds the manifest digest to canonical content and commit', () => {
    const original = manifest();
    const reordered = {
      manifestDigest: original.manifestDigest,
      artifacts: [...original.artifacts].reverse(),
      commit: original.commit,
      schemaVersion: original.schemaVersion,
    };
    expect(computePublicBetaArtifactManifestDigest(reordered)).toBe(original.manifestDigest);
    expect(() =>
      parsePublicBetaArtifactManifest({ ...original, manifestDigest: DIGEST_B }),
    ).toThrow('PUBLIC_BETA_ARTIFACT_MANIFEST_DIGEST_INVALID');
    expect(() =>
      verifyPublicBetaArtifactManifest(original, {
        expectedCommit: 'b'.repeat(40),
        ...verifiers(),
      }),
    ).toThrow('PUBLIC_BETA_ARTIFACT_COMMIT_MISMATCH');
  });

  test('requires all independent verifiers before reporting a verified manifest', () => {
    const value = parsePublicBetaArtifactManifest(manifest());
    expect(() => verifyPublicBetaArtifactManifest(value, { expectedCommit: COMMIT })).toThrow(
      'PUBLIC_BETA_ARTIFACT_VERIFIER_REQUIRED',
    );
    expect(() =>
      verifyPublicBetaArtifactManifest(value, {
        expectedCommit: COMMIT,
        ...verifiers(),
        verifyProvenance: undefined,
      }),
    ).toThrow('PUBLIC_BETA_PROVENANCE_VERIFIER_REQUIRED');
  });

  test('checks every artifact, SBOM, and provenance binding', () => {
    const value = parsePublicBetaArtifactManifest(manifest());
    const seen = { artifact: 0, sbom: 0, provenance: 0 };
    const result = verifyPublicBetaArtifactManifest(value, {
      expectedCommit: COMMIT,
      verifyArtifact: () => {
        seen.artifact += 1;
        return true;
      },
      verifySbom: () => {
        seen.sbom += 1;
        return true;
      },
      verifyProvenance: () => {
        seen.provenance += 1;
        return true;
      },
    });
    expect(result).toEqual(value);
    expect(seen).toEqual({
      artifact: PUBLIC_BETA_ARTIFACT_NAMES.length,
      sbom: PUBLIC_BETA_ARTIFACT_NAMES.length,
      provenance: PUBLIC_BETA_ARTIFACT_NAMES.length,
    });

    expect(() =>
      verifyPublicBetaArtifactManifest(value, {
        ...verifiers(),
        expectedCommit: COMMIT,
        verifySbom: () => false,
      }),
    ).toThrow('PUBLIC_BETA_SBOM_UNVERIFIED');
    expect(() =>
      verifyPublicBetaArtifactManifest(value, {
        ...verifiers(),
        expectedCommit: COMMIT,
        verifyProvenance: () => false,
      }),
    ).toThrow('PUBLIC_BETA_PROVENANCE_UNVERIFIED');
  });
});
