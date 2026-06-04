/**
 * ProcessCodeView — the "generated code" panel that floats over the PROCESS
 * canvas in the Factory Builder. The killer AnyLogic-equivalent feature:
 * shows the user, in real time, that their visual graph compiles to
 * runnable TypeScript source.
 *
 * Architecture mirrored from AnyLogic — diagram → IR → generated code →
 * runtime. The runtime symbols emitted here (`Source`, `Service`, …) are
 * placeholders for the Phase-3 graph engine; until then the code is
 * readable, copy-paste-able pseudo-TS that documents the model.
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { SW_COLORS, SW_FONTS } from '../design/tokens';
import {
  getBlockSpec,
  getBlockParams,
  apparelRoleFor,
  type PmlBlockKind,
  type ResolvedBlockParams,
} from '../domain/pml';
import type { Connector, Twin, Workstation } from '../domain/twin';

interface ProcessCodeViewProps {
  twin: Twin;
}

// ============================================================================
// CODE GENERATION — twin → readable TypeScript source
// ============================================================================

/** All flow / lifecycle / routing / batch kinds get a flow-style emit. */
const FLOW_KINDS: Set<PmlBlockKind> = new Set<PmlBlockKind>([
  'Source',
  'Sink',
  'Queue',
  'Delay',
  'Hold',
  'Wait',
  'Service',
  'Seize',
  'Release',
  'SelectOutput',
  'SelectOutput5',
  'Batch',
  'Unbatch',
  'Combine',
  'Match',
  'Assembler',
  'Split',
  'MoveTo',
  'Conveyor',
]);

/** Identifier-safe lowercase name for a kind: "SelectOutput" → "selectOutput". */
function camelKind(kind: PmlBlockKind): string {
  return kind.charAt(0).toLowerCase() + kind.slice(1);
}

/** Escape a string so it can sit between single quotes in emitted TS. */
function tsQuote(s: string): string {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Render a single key:value field; null/undefined values are skipped. */
function field(key: string, value: string | number | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return `${key}: ${value}`;
}

/** Format a number compactly — integers as integers, decimals with 2 places. */
function num(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toFixed(2);
}

/**
 * Emit the constructor-args object literal for a single block. The fields
 * emitted are exactly those that matter for the block's kind — Source gets
 * `ratePerHr` + `piecesPerAgent`, Service gets `cycleS` + `servers` + `pool`,
 * etc. This matches `PARAM_FIELDS_BY_KIND` in pml.ts.
 */
function emitBlockArgs(
  kind: PmlBlockKind,
  name: string,
  params: ResolvedBlockParams,
  poolVar: string | null,
): string {
  const parts: (string | null)[] = [field('name', tsQuote(name))];

  switch (kind) {
    case 'Source':
      parts.push(field('ratePerHr', num(params.sourceRatePerHr)));
      parts.push(field('piecesPerAgent', num(params.piecesPerAgent)));
      break;
    case 'Service':
      parts.push(field('cycleS', num(params.cycleS)));
      parts.push(field('servers', num(params.servers)));
      if (poolVar) parts.push(field('pool', poolVar));
      break;
    case 'Delay':
    case 'Hold':
    case 'Wait':
    case 'Conveyor':
    case 'MoveTo':
      parts.push(field('cycleS', num(params.cycleS)));
      break;
    case 'Queue':
      if (params.queueCapacity > 0) {
        parts.push(field('capacity', num(params.queueCapacity)));
      }
      break;
    case 'SelectOutput':
      parts.push(field('passProb', num(params.passProb)));
      break;
    case 'Batch':
      parts.push(field('batchSize', num(params.batchSize)));
      break;
    case 'ResourcePool':
      parts.push(field('capacity', num(params.capacity)));
      break;
    case 'Seize':
    case 'Release':
    case 'Assembler':
      if (poolVar) parts.push(field('pool', poolVar));
      break;
    default:
      break;
  }

  const filled = parts.filter((p): p is string => p !== null);
  return `{ ${filled.join(', ')} }`;
}

/** Stable, deterministic identifier for one workstation's emitted block. */
function variableName(kind: PmlBlockKind, index: number): string {
  return `${camelKind(kind)}_${index + 1}`;
}

/**
 * Generate the full TS source for a twin. Stable for a given twin payload,
 * pure (no side effects), no DOM access.
 */
export function generateTsCode(twin: Twin): string {
  if (twin.workstations.length === 0) {
    return [
      `// Stitchworks model — ${twin.name}`,
      `// (empty model — drop a Source / Queue / Service / Sink in the palette to start)`,
    ].join('\n');
  }

  // ── Resolve every workstation to its block spec + params ────────────────
  const resolved = twin.workstations.map((ws, i) => {
    const spec = getBlockSpec(ws);
    const params = getBlockParams(ws);
    return { ws, spec, params, originalIndex: i };
  });

  // ── Split into resource pools vs flow blocks ────────────────────────────
  const pools = resolved.filter((r) => r.spec.kind === 'ResourcePool');
  const flow = resolved.filter((r) => FLOW_KINDS.has(r.spec.kind));

  // Order flow blocks by department-then-x so the emitted code reads in the
  // same left-to-right order the swim-lane diagram reads. Mirrors the layout
  // logic inside BuilderProcessView so codegen + canvas tell the same story.
  const deptOrder = new Map<string, number>();
  [...twin.departments]
    .sort((a, b) => (a.bounds.y - b.bounds.y) || (a.bounds.x - b.bounds.x))
    .forEach((d, i) => deptOrder.set(d.id, i));
  flow.sort((a, b) => {
    const da = deptOrder.get(a.ws.deptId) ?? 999;
    const db = deptOrder.get(b.ws.deptId) ?? 999;
    if (da !== db) return da - db;
    if (a.ws.position.x !== b.ws.position.x) return a.ws.position.x - b.ws.position.x;
    return a.ws.position.y - b.ws.position.y;
  });

  // Stable wsId → variable name map. Use the *post-sort* index so order
  // matches the emitted declaration order.
  const varOf = new Map<string, string>();
  pools.forEach((p, i) => varOf.set(p.ws.id, variableName('ResourcePool', i)));
  flow.forEach((f, i) => varOf.set(f.ws.id, variableName(f.spec.kind, i)));

  // For Service / Seize / Release / Assembler — pick a pool to bind to.
  // Heuristic for Phase 1: if the same department has exactly one pool,
  // bind to that. Otherwise leave the pool unset and emit a TODO comment.
  function poolForServiceLike(ws: Workstation): { varName: string | null; note: string | null } {
    const sameDept = pools.filter((p) => p.ws.deptId === ws.deptId);
    if (sameDept.length === 1) {
      return { varName: varOf.get(sameDept[0].ws.id) ?? null, note: null };
    }
    if (sameDept.length === 0) return { varName: null, note: '// TODO: bind to a ResourcePool' };
    return { varName: null, note: '// TODO: pick one of: ' + sameDept.map((p) => varOf.get(p.ws.id)).join(', ') };
  }

  // ── Build the source ─────────────────────────────────────────────────────
  const out: string[] = [];

  // Header
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  out.push(`// Stitchworks model — ${twin.name}`);
  out.push(`// Generated ${ts} · ${flow.length} flow block${flow.length === 1 ? '' : 's'} · ${pools.length} pool${pools.length === 1 ? '' : 's'} · ${twin.connectors.length} connector${twin.connectors.length === 1 ? '' : 's'}`);
  out.push('');

  // Imports — derive from kinds actually used.
  const usedKinds = new Set<PmlBlockKind>();
  pools.forEach((p) => usedKinds.add(p.spec.kind));
  flow.forEach((f) => usedKinds.add(f.spec.kind));
  const importList = ['Simulation', 'connect', ...Array.from(usedKinds).sort()];
  out.push(`import { ${importList.join(', ')} } from '@stitchworks/runtime';`);
  out.push('');

  // ── Resource pools ──────────────────────────────────────────────────────
  if (pools.length > 0) {
    out.push('// ── Resource pools ──────────────────────────────────────────');
    pools.forEach((p) => {
      const varName = varOf.get(p.ws.id)!;
      const role = apparelRoleFor(p.ws);
      const displayName = `${role} · ${p.ws.name}`;
      const args = emitBlockArgs(p.spec.kind, displayName, p.params, null);
      out.push(`const ${varName} = new ResourcePool(${args});`);
    });
    out.push('');
  }

  // ── Flow blocks ─────────────────────────────────────────────────────────
  if (flow.length > 0) {
    out.push('// ── Flow blocks ─────────────────────────────────────────────');
    flow.forEach((f) => {
      const varName = varOf.get(f.ws.id)!;
      const role = apparelRoleFor(f.ws);
      const displayName = `${role} · ${f.ws.name}`;

      let poolNote: string | null = null;
      let poolVar: string | null = null;
      if (f.spec.kind === 'Service' || f.spec.kind === 'Seize' || f.spec.kind === 'Release' || f.spec.kind === 'Assembler') {
        const r = poolForServiceLike(f.ws);
        poolVar = r.varName;
        poolNote = r.note;
      }

      const args = emitBlockArgs(f.spec.kind, displayName, f.params, poolVar);
      const trailing = poolNote ? '  ' + poolNote : '';
      out.push(`const ${varName} = new ${f.spec.kind}(${args});${trailing}`);
    });
    out.push('');
  }

  // ── Connectors ──────────────────────────────────────────────────────────
  if (twin.connectors.length > 0) {
    out.push('// ── Connectors ──────────────────────────────────────────────');
    twin.connectors.forEach((c: Connector) => {
      const fromVar = varOf.get(c.fromWsId);
      const toVar = varOf.get(c.toWsId);
      if (!fromVar || !toVar) return;
      const fromWs = twin.workstations.find((w) => w.id === c.fromWsId);
      const toWs = twin.workstations.find((w) => w.id === c.toWsId);
      if (!fromWs || !toWs) return;
      const fromSpec = getBlockSpec(fromWs);
      const toSpec = getBlockSpec(toWs);
      const fromPort = c.fromPort ?? fromSpec.outputs[0]?.id ?? 'out';
      const toPort = c.toPort ?? toSpec.inputs[0]?.id ?? 'in';
      out.push(`connect(${fromVar}.out(${tsQuote(fromPort)}), ${toVar}.in(${tsQuote(toPort)}));`);
    });
    out.push('');
  } else if (flow.length > 0) {
    out.push('// (no connectors — draw wires between port dots to define flow)');
    out.push('');
  }

  // ── Runner ──────────────────────────────────────────────────────────────
  if (flow.length > 0) {
    const allFlowVars = flow.map((f) => varOf.get(f.ws.id)!);
    const allPoolVars = pools.map((p) => varOf.get(p.ws.id)!);
    out.push('// ── Run ─────────────────────────────────────────────────────');
    out.push('const sim = new Simulation({');
    out.push(`  blocks: [${allFlowVars.join(', ')}],`);
    if (allPoolVars.length > 0) {
      out.push(`  resources: [${allPoolVars.join(', ')}],`);
    }
    out.push('  untilHours: 8,');
    out.push('});');
    out.push('sim.run();');
  }

  return out.join('\n');
}

// ============================================================================
// SYNTAX HIGHLIGHTING — light regex-based tinting, no Prism dependency
// ============================================================================

const HL_COLORS = {
  comment: '#6b7480',
  keyword: '#c792ea',
  type: '#82d3a3',
  string: '#ffb86c',
  number: '#ffd479',
  text: '#d8dee9',
};

const KEYWORDS = new Set(['import', 'from', 'const', 'new', 'connect', 'sim']);

const TYPES = new Set([
  'Source', 'Sink', 'Queue', 'Delay', 'Hold', 'Wait',
  'Service', 'Seize', 'Release', 'ResourcePool',
  'SelectOutput', 'SelectOutput5',
  'Batch', 'Unbatch', 'Combine', 'Match', 'Assembler', 'Split',
  'MoveTo', 'Conveyor',
  'Simulation',
]);

const TOKEN_REGEX = /('[^']*')|(\/\/[^\n]*)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)|([^'/\d\w])/g;

/** Tokenize one line and wrap each token in a coloured span. */
function highlightLine(line: string, lineIdx: number): ReactNode {
  // Comment-only lines short-circuit so trailing `// note` after code colours correctly.
  if (line.trimStart().startsWith('//')) {
    return <span style={{ color: HL_COLORS.comment }}>{line || ' '}</span>;
  }
  const pieces: ReactNode[] = [];
  let match: RegExpExecArray | null;
  TOKEN_REGEX.lastIndex = 0;
  let last = 0;
  let key = 0;
  while ((match = TOKEN_REGEX.exec(line)) !== null) {
    if (match.index > last) {
      pieces.push(<span key={`t${lineIdx}-${key++}`}>{line.slice(last, match.index)}</span>);
    }
    const [tok, str, comm, numTok, word] = match;
    let color = HL_COLORS.text;
    if (str !== undefined) color = HL_COLORS.string;
    else if (comm !== undefined) color = HL_COLORS.comment;
    else if (numTok !== undefined) color = HL_COLORS.number;
    else if (word !== undefined) {
      if (KEYWORDS.has(word)) color = HL_COLORS.keyword;
      else if (TYPES.has(word)) color = HL_COLORS.type;
    }
    pieces.push(<span key={`t${lineIdx}-${key++}`} style={{ color }}>{tok}</span>);
    last = match.index + tok.length;
  }
  if (last < line.length) {
    pieces.push(<span key={`t${lineIdx}-${key}`}>{line.slice(last)}</span>);
  }
  return pieces.length > 0 ? <>{pieces}</> : <span>{' '}</span>;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ProcessCodeView({ twin }: ProcessCodeViewProps) {
  // Default collapsed — the code view is a power-user surface, not the
  // non-engineer default. Click the floating `{ } CODE` pill to expand.
  const [collapsed, setCollapsed] = useState(true);
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => generateTsCode(twin), [twin]);
  const lines = useMemo(() => code.split('\n'), [code]);

  function onCopy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {/* ignore */},
    );
  }

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        title="Show generated code"
        style={{
          position: 'absolute',
          bottom: 56,
          left: 14,
          zIndex: 6,
          background: '#0e1116',
          color: '#d8dee9',
          border: '1px solid #1f2530',
          borderRadius: 6,
          padding: '6px 10px',
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: '0.12em',
          cursor: 'pointer',
        }}
      >
        {'{ } CODE'}
      </button>
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 56,
        left: 14,
        zIndex: 6,
        width: 480,
        maxHeight: '70vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#0e1116',
        color: HL_COLORS.text,
        border: '1px solid #1f2530',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(15, 20, 25, 0.18)',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: '#161b22',
          borderBottom: '1px solid #1f2530',
          padding: '8px 12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: SW_COLORS.brand,
            }}
          />
          <span
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: '0.14em',
              color: '#c0c8d4',
            }}
          >
            GENERATED CODE · TypeScript
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={onCopy}
            title="Copy to clipboard"
            style={codeBtnStyle(copied)}
          >
            {copied ? 'COPIED' : 'COPY'}
          </button>
          <button
            onClick={() => setCollapsed(true)}
            title="Hide panel"
            style={codeBtnStyle(false)}
          >
            HIDE
          </button>
        </div>
      </header>

      <div
        style={{
          padding: '4px 0',
          overflow: 'auto',
          flex: 1,
          fontFamily: SW_FONTS.mono,
          fontSize: 11,
          lineHeight: 1.55,
        }}
      >
        <pre style={{ margin: 0, padding: '8px 14px', whiteSpace: 'pre' }}>
          {lines.map((line, i) => (
            <div key={i} style={{ display: 'flex' }}>
              <span
                style={{
                  display: 'inline-block',
                  width: 28,
                  textAlign: 'right',
                  marginRight: 12,
                  color: '#3d4856',
                  userSelect: 'none',
                  flex: '0 0 auto',
                }}
              >
                {i + 1}
              </span>
              <span style={{ flex: 1 }}>{highlightLine(line, i)}</span>
            </div>
          ))}
        </pre>
      </div>

      <footer
        style={{
          background: '#161b22',
          borderTop: '1px solid #1f2530',
          padding: '6px 12px',
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: '#6b7480',
        }}
      >
        {twin.workstations.length} BLOCKS · {twin.connectors.length} WIRES · LIVE-UPDATES AS YOU EDIT
      </footer>
    </div>
  );
}

function codeBtnStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? SW_COLORS.brand : 'transparent',
    color: active ? '#fff' : '#c0c8d4',
    border: '1px solid ' + (active ? SW_COLORS.brand : '#2a3340'),
    borderRadius: 4,
    padding: '3px 8px',
    fontFamily: SW_FONTS.mono,
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '0.1em',
    cursor: 'pointer',
  };
}
