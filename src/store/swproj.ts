/**
 * `.swproj` project file format — the "proper formats" seam.
 *
 * Why a versioned envelope:
 *   The old export wrote the project store ONLY (downloadProjectJson →
 *   exportProject). The twin — every department, workstation, connector,
 *   operator and scenario fork, i.e. the actual factory layout — was NOT in
 *   the file, so an exported `.swproj` could not rebuild the factory. This
 *   envelope bundles BOTH stores and stamps the schema versions so a future
 *   build can migrate an old file instead of rejecting it.
 *
 * Backward compatibility:
 *   parseSwproj() also accepts a legacy bare-ProjectState file (the old
 *   format had no `format` field) so existing `.swproj` files still import —
 *   they just restore the project half, leaving the current twin in place.
 *
 * Layering: this module orchestrates the two stores (it imports useProject /
 * useTwin), so the stores must NOT import it back — keep the dependency
 * one-way to avoid an import cycle.
 */

import { z } from 'zod';
import { useProject, PROJECT_SCHEMA_VERSION, type ProjectState } from './project';
import { useTwin, TWIN_STORE_SCHEMA_VERSION } from './twin';
import { normalizeTwin, validateTwin, type Twin, type Scenario } from '../domain/twin';

export const SWPROJ_FORMAT = 'stitchworks-project';
export const SWPROJ_FORMAT_VERSION = 1;
/** App build stamped into exports for provenance (informational only). */
const APP_VERSION = '0.2.0';

/** The twin half of a `.swproj` — exactly what useTwin.exportTwin() returns. */
export interface TwinExport {
  schemaVersion: number;
  canonical: Twin;
  scenarios: Scenario[];
  activeScenarioId: string | null;
}

export interface SwprojEnvelope {
  format: typeof SWPROJ_FORMAT;
  formatVersion: number;
  app: { name: string; version: string };
  /** Schema versions of the embedded payloads, so importers can migrate. */
  schemas: { project: number; twin: number };
  exportedAt: string;
  data: {
    project: ProjectState;
    twin: TwinExport;
  };
}

// ---------------------------------------------------------------------------
// Validation + format migration
// ---------------------------------------------------------------------------

// Structural schemas — validate the shape that matters for a SAFE import (the
// format discriminator, version, and that the embedded project + twin look
// right). Deeper integrity is handled downstream by loadProject +
// validateTwin/normalizeTwin. NB: these are used for validation ONLY via
// safeParse; the original (unstripped) data is what actually gets imported,
// so zod's key-stripping never drops real ProjectState/Twin fields.
const projectShape = z.object({
  schemaVersion: z.number(),
  meta: z.object({ name: z.string() }),
});
const envelopeSchema = z.object({
  format: z.literal(SWPROJ_FORMAT),
  formatVersion: z.number(),
  data: z.object({
    project: projectShape,
    twin: z.object({ canonical: z.object({}) }).optional(),
  }),
});

function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * Ordered envelope-version upgraders — the explicit migration registry for the
 * file format. formatVersion 1 is current so there are none yet; when the
 * envelope shape changes, a `1: (env) => ({...})` step lands here so old files
 * keep importing instead of being rejected.
 */
const ENVELOPE_MIGRATIONS: Record<number, (env: Record<string, unknown>) => Record<string, unknown>> = {
  // 1: (env) => ({ ...env, formatVersion: 2, /* shape change */ }),
};

function migrateEnvelope(env: Record<string, unknown>): Record<string, unknown> {
  let v = typeof env.formatVersion === 'number' ? env.formatVersion : 1;
  if (v > SWPROJ_FORMAT_VERSION) {
    throw new Error(
      `This .swproj was saved by a newer Stitchworks (format v${v}); this build supports up to v${SWPROJ_FORMAT_VERSION}. Update the app to open it.`,
    );
  }
  let out = env;
  while (v < SWPROJ_FORMAT_VERSION) {
    const step = ENVELOPE_MIGRATIONS[v];
    if (!step) break;
    out = step(out);
    v += 1;
  }
  return out;
}

/** Build an envelope from the two store exports. Pure. */
export function buildSwproj(
  project: ProjectState,
  twin: TwinExport,
  exportedAt: string,
): SwprojEnvelope {
  return {
    format: SWPROJ_FORMAT,
    formatVersion: SWPROJ_FORMAT_VERSION,
    app: { name: 'Stitchworks', version: APP_VERSION },
    schemas: { project: PROJECT_SCHEMA_VERSION, twin: TWIN_STORE_SCHEMA_VERSION },
    exportedAt,
    data: { project, twin },
  };
}

export interface ParsedSwproj {
  project: ProjectState;
  /** Null when the source was a legacy project-only file. */
  twin: TwinExport | null;
  legacy: boolean;
}

/**
 * Interpret raw parsed JSON as a `.swproj`. Accepts the versioned envelope
 * AND the legacy bare-ProjectState format. Throws with a human-readable
 * reason on shapes it can't interpret (the caller surfaces it as a toast).
 */
export function parseSwproj(raw: unknown): ParsedSwproj {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Not a valid .swproj file (expected a JSON object).');
  }
  const obj = raw as Record<string, unknown>;

  // Versioned envelope — discriminated by the `format` field.
  if (obj.format === SWPROJ_FORMAT) {
    const migrated = migrateEnvelope(obj);
    const check = envelopeSchema.safeParse(migrated);
    if (!check.success) {
      throw new Error(`Corrupt .swproj envelope — ${formatZodError(check.error)}.`);
    }
    const data = migrated.data as { project: ProjectState; twin?: TwinExport };
    return { project: data.project, twin: data.twin ?? null, legacy: false };
  }

  // Legacy: the file IS a bare ProjectState (has schemaVersion + meta).
  if ('schemaVersion' in obj && 'meta' in obj) {
    const check = projectShape.safeParse(obj);
    if (!check.success) {
      throw new Error(`Corrupt legacy project file — ${formatZodError(check.error)}.`);
    }
    return { project: obj as unknown as ProjectState, twin: null, legacy: true };
  }

  throw new Error('Unrecognised .swproj file — no `format` field and not a legacy project file.');
}

/** Trigger a download of the current project + twin as a versioned `.swproj`. */
export function downloadSwproj(): void {
  const project = useProject.getState().exportProject();
  const twin = useTwin.getState().exportTwin();
  const envelope = buildSwproj(project, twin, new Date().toISOString());
  const json = JSON.stringify(envelope, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const filename = `${(project.meta?.name || 'stitchworks').replace(/[^a-z0-9-_]/gi, '-')}.swproj`;
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ApplySwprojResult {
  ok: boolean;
  reason?: string;
  legacy: boolean;
}

/**
 * Apply a parsed `.swproj` to the live stores. Validates before writing so a
 * malformed file can't corrupt state — on any failure nothing is applied past
 * the project load and a reason is returned. The twin is normalised (missing
 * fields filled) then referential-integrity checked via validateTwin.
 */
export function applySwproj(parsed: ParsedSwproj): ApplySwprojResult {
  const pr = useProject.getState().loadProject(parsed.project);
  if (!pr.ok) return { ok: false, reason: pr.reason, legacy: parsed.legacy };

  if (parsed.twin) {
    const canonical = normalizeTwin(parsed.twin.canonical);
    const errs = validateTwin(canonical);
    if (errs.length > 0) {
      return { ok: false, reason: `Factory layout invalid: ${errs.join('; ')}`, legacy: parsed.legacy };
    }
    const scenarios = (parsed.twin.scenarios ?? []).map((sc) => ({
      ...sc,
      twin: normalizeTwin(sc.twin),
    }));
    useTwin.setState({
      schemaVersion: TWIN_STORE_SCHEMA_VERSION,
      canonical,
      scenarios,
      activeScenarioId: parsed.twin.activeScenarioId ?? null,
      past: [],
      future: [],
    });
  }

  return { ok: true, legacy: parsed.legacy };
}
