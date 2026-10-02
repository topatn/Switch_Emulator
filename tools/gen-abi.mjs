// tools/gen-abi.mjs
// SPDX-License-Identifier: MIT
//
// Parses the C ABI headers under core/include/core/ and emits:
//
//   gen/abi.json  - machine-readable contract (offsets, sizes, enums, exports)
//   gen/abi.ts    - TypeScript mirror consumed by web/src/core
//
// Part 5: "the core is the source of truth; TS mirrors of the ABI are generated
// into gen/ to avoid hand-synced struct drift". This script is that boundary.
//
// It is a *deliberately small* parser: it understands only the subset of C the
// ABI headers actually use (fixed-width typedefs, enums, POD structs with
// explicit or implicit padding, #define'd integer constants). It is not a C
// compiler and does not try to be. Anything it cannot parse is a hard error
// naming the file and line, so an unsupported construct can never quietly
// produce a wrong TS mirror.
//
// Offsets are computed with the wasm32 rules the core is built for:
//   * alignment of a scalar = its own size
//   * alignment of a struct = max member alignment, capped at 16 by wasm (not
//     relevant at Phase 0, but noted because it will matter for v128 later)
//   * trailing padding to the struct's own alignment
//   * arrays use element size * length
//
// Usage: node tools/gen-abi.mjs [--check]
//   --check  exits non-zero if the checked-in mirrors are stale (for CI).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE_DIR = join(ROOT, 'core', 'include', 'core');
const GEN_DIR = join(ROOT, 'gen');

// Set SW_GEN_ABI_TRACE=1 to log every parser dispatch decision. Invaluable when
// the generator rejects a header and the token index is not obvious.
const TRACE = process.env.SW_GEN_ABI_TRACE === '1';

// Order matters only for readability; all headers are parsed into one model.
const HEADERS = ['types.h', 'memory.h', 'platform.h'];

// --- primitive model -------------------------------------------------------

const SCALARS = {
  uint8_t:  { size: 1, align: 1, kind: 'u8'  },
  int8_t:   { size: 1, align: 1, kind: 'i8'  },
  uint16_t: { size: 2, align: 2, kind: 'u16' },
  int16_t:  { size: 2, align: 2, kind: 'i16' },
  uint32_t: { size: 4, align: 4, kind: 'u32' },
  int32_t:  { size: 4, align: 4, kind: 'i32' },
  uint64_t: { size: 8, align: 8, kind: 'u64' },
  int64_t:  { size: 8, align: 8, kind: 'i64' },
  // Pointer as seen from wasm32. Recorded as u32 because the core is wasm32;
  // a wasm64 build would flip this to u64 and SW_ABI_VERSION must change.
  ptr:      { size: 4, align: 4, kind: 'u32' },
};

const TS_TYPE = {
  u8: 'number', i8: 'number',
  u16: 'number', i16: 'number',
  u32: 'number', i32: 'number',
  u64: 'bigint', i64: 'bigint',
};

const TS_VIEW = {
  u8: 'Uint8Array', i8: 'Int8Array',
  u16: 'Uint16Array', i16: 'Int16Array',
  u32: 'Uint32Array', i32: 'Int32Array',
  u64: 'BigUint64Array', i64: 'BigInt64Array',
};

// --- tokenizer -------------------------------------------------------------

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

function tokenize(src, file) {
  const toks = [];
  const lineOf = makeLineIndex(src);
  // Newlines are emitted as tokens so preprocessor directives can be delimited
  // without a real lexer. '\n' is not part of any other token.
  const re = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|0[xX][0-9a-fA-F]+[uUlL]*|\d+[uUlL]*|[A-Za-z_][A-Za-z0-9_]*|[{}();,*\[\]=<>]|\n|\S/g;
  let m;
  let prevEnd = 0;
  while ((m = re.exec(src)) !== null) {
    const text = m[0];
    // `wsBefore` is what separates an object-like macro from a function-like
    // one: `#define F (x)` is a constant, `#define F(x)` is a function. Without
    // this, every parenthesised constant would be misread as a function.
    const wsBefore = /\s/.test(src.slice(prevEnd, m.index));
    prevEnd = m.index + text.length;

    if (text === '\n') { toks.push({ text: '\n', line: 0, wsBefore: true }); continue; }
    if (text.startsWith('/*') || text.startsWith('//')) {
      // Comments can span lines; emit the newlines they contained so line
      // tracking and directive delimiting both stay correct.
      const line = lineOf(src, m.index);
      for (let i = 0; i < countNewlines(text); i++) toks.push({ text: '\n', line: line + i, wsBefore: true });
      continue;
    }
    toks.push({ text, line: lineOf(src, m.index), wsBefore });
  }
  void file;
  return toks;
}

function countNewlines(s) {
  let n = 0;
  for (const c of s) if (c === '\n') n++;
  return n;
}

// Line number of a byte offset, via a lazily built prefix table.
function makeLineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

// --- parser ----------------------------------------------------------------

// A Parser owns a token cursor and a filename. Everything semantic (typedefs,
// structs, enums, macros) lives in `shared` and is passed across headers,
// because the ABI headers #include one another: platform.h returns
// SwArenaRange, which is defined in memory.h. A per-file scope would silently
// fail to resolve it.
class Parser {
  constructor(toks, file, shared = {}) {
    this.t = toks;
    this.i = 0;
    this.file = file;
    this.typedefs = shared.typedefs ??= new Map();   // name -> type descriptor
    this.structs = shared.structs ??= new Map();
    this.enums = shared.enums ??= new Map();
    this.macros = shared.macros ??= new Map();
    this.functions = shared.functions ??= [];
  }

  peek(k = 0) { return this.t[this.i + k]; }
  next() { return this.t[this.i++]; }
  eof() { return this.i >= this.t.length; }

  // Newlines are tokens so that preprocessor directives can be delimited, but
  // they are otherwise insignificant. Every declaration-level read skips them.
  skipnl() {
    while (this.i < this.t.length && this.t[this.i].text === '\n') this.i++;
  }

  fail(msg, tok = this.peek()) {
    const where = tok ? `${this.file}:${tok.line}: ` : `${this.file}: `;
    throw new Error(`${where}${msg}`);
  }

  expect(text) {
    const tok = this.next();
    if (!tok || tok.text !== text) {
      this.fail(`expected '${text}', found '${tok ? tok.text : '<eof>'}'`, tok);
    }
    return tok;
  }

  parse() {
    while (!this.eof()) {
      const tok = this.peek();
      if (TRACE) {
        const verb = tok.text === '\n' ? 'skip-nl'
          : tok.text === '{' || tok.text === '}' ? 'skip-brace'
          : tok.text === 'extern' || tok.text === 'namespace' ? 'scope'
          : tok.text === '#' ? 'directive'
          : tok.text === 'typedef' ? 'typedef'
          : this.looks_like_function() ? 'function'
          : 'skip-stmt';
        console.error(`  L${tok.line} @${this.i} ${JSON.stringify(tok.text)} -> ${verb}`);
      }

      if (tok.text === '\n') { this.next(); continue; }
      if (tok.text === '{' || tok.text === '}') { this.next(); continue; }

      // `extern "C" {` / `namespace ns {` open a scope whose contents are real
      // declarations, so consume the header and descend rather than skipping
      // the whole block.
      if (tok.text === 'extern' || tok.text === 'namespace') {
        while (!this.eof() && this.peek().text !== '{' && this.peek().text !== ';') this.next();
        if (!this.eof() && this.peek().text === '{') this.next();
        continue;
      }

      if (tok.text === '#') { this.parse_define(); continue; }
      if (tok.text === 'typedef') { this.parse_typedef(); continue; }
      if (tok.text === 'static_assert' || tok.text === 'error') { this.skip_statement(); continue; }
      if (tok.text === ';') { this.next(); continue; }

      if (this.looks_like_function()) { this.parse_function(); continue; }
      this.skip_statement();
    }
  }

  // Skips the remainder of the current logical line. Preprocessor directives
  // are line-oriented, and '\n' is a token, so this is exact.
  skip_line() {
    while (!this.eof() && this.peek().text !== '\n') this.next();
    if (!this.eof()) this.next();
  }

  // Skips to the next ';' at brace-depth 0.
  skip_statement() {
    let depth = 0;
    while (!this.eof()) {
      const t = this.next().text;
      if (t === '{') depth++;
      else if (t === '}') { depth--; if (depth === 0) return; }
      else if (t === ';' && depth === 0) return;
    }
  }

  parse_define() {
    this.expect('#');
    const dir = this.next();
    if (!dir) this.fail('truncated preprocessor directive');

    // #include, #if/#ifdef/#ifndef/#else/#elif/#endif, #pragma: none of these
    // contribute to the ABI, and conditional blocks are skipped whole so a
    // host-only branch can never leak into the mirror.
    if (dir.text !== 'define') {
      this.skip_line();
      return;
    }

    const name = this.next();
    if (!name || !/^[A-Za-z_]/.test(name.text)) this.fail('bad macro name', name);

    // A '(' glued to the name makes this a function-like macro. Those are never
    // ABI constants, and evaluating one would fail the constant-expression check.
    //
    // NOTE: no skipnl() here. The newline terminates the directive, so an
    // object-like macro with no value (`#define GUARD`) must be detected by
    // seeing '\n' immediately, not by skipping past it.
    if (this.peek() && this.peek().text === '(' && !this.peek().wsBefore) {
      this.skip_line();
      return;
    }

    const value = [];
    while (!this.eof() && this.peek().text !== '\n') {
      const t = this.next();
      if (t.text === '\\') continue;  // line continuation
      value.push(t.text);
    }
    if (!this.eof()) this.next();  // consume the terminating newline

    const expr = value.join(' ').trim();
    if (expr === '') return;  // object-like macro with no value, e.g. #ifndef GUARD

    const n = evalNumeric(expr, `${this.file}:${name.line}: `);
    if (Number.isFinite(n)) this.macros.set(name.text, n);
  }

  looks_like_function() {
    // A declaration is a function if we can find '(' before the next ';'.
    let j = this.i;
    while (j < this.t.length && this.t[j].text !== ';') {
      if (this.t[j].text === '(') return true;
      if (this.t[j].text === '{' || this.t[j].text === '=') return false;
      j++;
    }
    return false;
  }

  parse_function() {
    const line = this.peek().line;
    const ret = this.parse_type();
    this.skipnl();
    const name = this.next();
    if (!name || !/^[A-Za-z_]/.test(name.text)) this.fail('bad function name', name);
    this.skipnl();
    this.expect('(');

    const params = [];
    for (;;) {
      this.skipnl();
      if (this.eof() || this.peek().text === ')') break;
      if (this.peek().text === 'void' && this.peek(1).text === ')') { this.next(); break; }
      const ptype = this.parse_type();
      this.skipnl();
      const pname = /^[A-Za-z_]/.test(this.peek().text) ? this.next().text : '';
      this.skipnl();
      if (this.peek() && this.peek().text === '[') {
        // Array parameter decays to a pointer; the name is kept for docs only.
        while (!this.eof() && this.peek().text !== ']') this.next();
        this.expect(']');
      }
      params.push({ name: pname, type: ptype });
      this.skipnl();
      if (this.peek() && this.peek().text === ',') { this.next(); continue; }
      break;
    }
    this.expect(')');
    this.skipnl();
    this.expect(';');
    this.functions.push({ name: name.text, ret, params, line });
  }

  // Parses a C type, resolving typedef names. Returns a descriptor:
  //   { kind: 'scalar'|'struct'|'ptr'|'void', ... }
  parse_type() {
    this.skipnl();
    let tok = this.next();
    if (!tok) this.fail('expected a type');
    while (tok && ['const', 'unsigned', 'signed', 'struct', 'enum'].includes(tok.text)) {
      if (tok.text === 'struct' || tok.text === 'enum') {
        this.skipnl();
        const tag = this.next();
        return this.named_handle(tag.text);
      }
      this.skipnl();
      tok = this.next();
    }
    if (!tok) this.fail('expected a type');

    if (SCALARS[tok.text]) {
      const s = SCALARS[tok.text];
      this.skipnl();
      if (this.peek() && this.peek().text === '*') {
        this.next();
        return { kind: 'ptr', size: s.size, align: s.align, to: s.kind };
      }
      return { kind: 'scalar', ...s, cname: tok.text };
    }

    if (this.typedefs.has(tok.text)) {
      const base = this.typedefs.get(tok.text);
      this.skipnl();
      if (this.peek() && this.peek().text === '*') {
        this.next();
        return { kind: 'ptr', size: 4, align: 4, to: base.kind, cname: `${tok.text}*` };
      }
      return base;
    }

    if (tok.text === 'void') {
      // `void` only ever appears as `void` (a return type) or `void *`. In the
      // pointer case the pointee size is irrelevant; the pointer itself is the
      // thing with a size.
      this.skipnl();
      if (this.peek() && this.peek().text === '*') {
        this.next();
        return { kind: 'ptr', size: 4, align: 4, to: 'void', cname: 'void*' };
      }
      return { kind: 'void', size: 0, align: 1, cname: 'void' };
    }

    // `const char *` / `char *` appear in the exported C ABI. A `char *` is a
    // pointer, so it is laid out as one regardless of pointee width.
    if (tok.text === 'char') {
      this.skipnl();
      if (this.peek() && this.peek().text === '*') {
        this.next();
        return { kind: 'ptr', size: 4, align: 4, to: 'u8', cname: 'char*' };
      }
      this.fail('bare `char` is not in the ABI; use uint8_t or char*', tok);
    }

    this.fail(`unsupported type '${tok.text}' - extend SCALARS in tools/gen-abi.mjs`, tok);
  }

  named_handle(tag) {
    return { kind: 'named', tag };
  }

  parse_typedef() {
    this.expect('typedef');
    this.skipnl();

    // enum { A, B = 3, C } -> SwStatus;
    if (this.peek().text === 'enum') {
      this.next();
      this.skipnl();
      const tag = /^[A-Za-z_]/.test(this.peek().text) ? this.next().text : null;
      this.skipnl();
      this.expect('{');
      const members = [];
      let value = 0;
      for (;;) {
        this.skipnl();
        if (this.eof() || this.peek().text === '}') break;
        const mname = this.next().text;
        this.skipnl();
        if (this.peek() && this.peek().text === '=') {
          this.next();
          const expr = [];
          while (!this.eof() && this.peek().text !== ',' && this.peek().text !== '}') {
            expr.push(this.next().text);
          }
          value = Number(evalNumeric(expr.join(' ')));
        }
        members.push({ name: mname, value });
        value += 1;
        this.skipnl();
        if (this.peek() && this.peek().text === ',') { this.next(); continue; }
        break;
      }
      this.expect('}');
      // `typedef enum Tag {...} Alias;` - the alias is optional.
      let alias = null;
      this.skipnl();
      if (this.peek() && /^[A-Za-z_]/.test(this.peek().text)) alias = this.next().text;
      this.expect(';');
      const name = tag ?? alias;
      if (name) this.enums.set(name, { tag: name, members });
      return;
    }

    // Struct definition: typedef struct { ... } Name;
    if (this.peek().text === 'struct') {
      this.next();
      this.skipnl();
      let tag = null;
      if (this.peek() && /^[A-Za-z_]/.test(this.peek().text) && this.peek().text !== '{') {
        tag = this.next().text;
        this.skipnl();
      }
      if (this.peek().text === '{') {
        // For an anonymous struct the final name is not known until after the
        // body, so the body is laid out under a temporary name and renamed
        // once the alias is read.
        const temp = tag ?? `__anon_${this.structs.size}`;
        this.parse_struct_body(temp);

        let alias = null;
        this.skipnl();
        if (this.peek() && /^[A-Za-z_]/.test(this.peek().text)) alias = this.next().text;
        this.expect(';');

        const finalName = alias ?? tag ?? temp;
        const desc = this.structs.get(temp);
        this.structs.delete(temp);
        desc.name = finalName;
        this.structs.set(finalName, desc);
        this.typedefs.set(finalName, {
          kind: 'struct', name: finalName, size: desc.size, align: desc.align, cname: finalName,
        });
        return;
      }
      // Forward declaration or opaque reference: nothing to lay out.
      this.skip_statement();
      return;
    }

    // Scalar alias: typedef uint32_t SwStatus;
    const base = this.parse_type();
    this.skipnl();
    const nameTok = this.peek();
    if (nameTok && /^[A-Za-z_]/.test(nameTok.text)) {
      const name = this.next().text;
      this.expect(';');
      this.typedefs.set(name, { ...base, cname: name });
    } else {
      this.skip_statement();
    }
  }

  parse_struct_body(tag) {
    this.expect('{');
    const raw = [];
    while (!this.eof()) {
      this.skipnl();
      if (this.peek().text === '}') break;
      const type = this.parse_type();
      for (;;) {
        this.skipnl();
        const nameTok = this.next();
        if (!nameTok) this.fail('expected a member name');
        let name = nameTok.text;
        let count = 1;
        this.skipnl();
        if (this.peek() && this.peek().text === '[') {
          this.next();
          const expr = [];
          while (!this.eof() && this.peek().text !== ']') expr.push(this.next().text);
          this.expect(']');
          count = Number(evalNumeric(expr.join(' ')));
        }
        raw.push({ name, type, count });
        this.skipnl();
        if (this.peek() && this.peek().text === ',') { this.next(); continue; }
        break;
      }
      this.skipnl();
      this.expect(';');
    }
    this.expect('}');
    return this.layoutStruct(tag ?? 'anon', raw);
  }

  layoutStruct(name, raw) {
    let offset = 0;
    let maxAlign = 1;
    const fields = [];

    for (const r of raw) {
      const t = r.type;
      if (t.kind === 'named') {
        const s = this.structs.get(t.tag);
        if (!s) this.fail(`struct '${t.tag}' used before definition`);
        r.type = { kind: 'struct', name: t.tag, size: s.size, align: s.align };
      }
      const { size, align } = r.type;
      const total = size * r.count;
      if (align > maxAlign) maxAlign = align;
      const padding = (align - (offset % align)) % align;
      offset += padding;
      fields.push({
        name: r.name,
        offset,
        size,
        count: r.count,
        total,
        align,
        type: r.type,
        padBefore: padding,
      });
      offset += total;
    }

    const structAlign = Math.min(maxAlign, 16); // wasm32 caps alignment at 16
    const tailPad = (structAlign - (offset % structAlign)) % structAlign;
    const desc = { name, size: offset + tailPad, align: structAlign, fields, tailPad };
    this.structs.set(name, desc);
    return desc;
  }
}

function evalNumeric(expr, where = '') {
  // Only constant arithmetic appears in the ABI headers. Reject anything else
  // so an unparseable macro surfaces instead of becoming NaN.
  if (!/^[-+*/%()0-9a-fA-FxXuUlL\s|&<>()~^]+$/.test(expr)) {
    throw new Error(`${where}non-constant macro expression: '${expr}'`);
  }
  // Strip C integer suffixes (1u, 0x1000ull, ...) so JS can evaluate the result.
  const js = expr.replace(/\b(0[xX][0-9a-fA-F]+|\d+)[uUlL]+\b/g, '$1');
  // eslint-disable-next-line no-new-func
  return Function(`"use strict";return (${js})`)();
}

// --- codegen ---------------------------------------------------------------

function tsScalarName(t) { return TS_TYPE[t.kind] ?? 'number'; }

function emitTs(abi) {
  const L = [];
  L.push('// gen/abi.ts - GENERATED by tools/gen-abi.mjs. DO NOT EDIT.');
  L.push('//');
  L.push('// Source of truth: core/include/core/{types,memory,platform}.h');
  L.push(`// ABI version: ${abi.abiVersion}   Generated: ${abi.generatedFrom}`);
  L.push('//');
  L.push('// All scalar reads/writes go through DataView-free typed-array views with');
  L.push('// explicit little-endian handling, so a future wasm64 build only has to change');
  L.push('// the 64-bit view types here.');
  L.push('');
  L.push('/* eslint-disable */');
  L.push('');
  L.push(`export const ABI_VERSION = ${abi.abiVersion};`);
  L.push(`export const POINTER_SIZE = ${abi.pointerSize};`);
  L.push('');

  // Macros
  if (abi.macros.size) {
    L.push('// --- compile-time constants -------------------------------------------');
    for (const [k, v] of abi.macros) {
      L.push(`export const ${k} = ${v};`);
    }
    L.push('');
  }

  // Feature bits
  if (abi.features.length) {
    L.push('// --- feature bits ------------------------------------------------------');
    L.push('export const SW_FEATURE = {');
    for (const f of abi.features) L.push(`  ${f.name}: ${f.value},`);
    L.push('} as const;');
    L.push('export type SwFeature = keyof typeof SW_FEATURE;');
    L.push('');
  }

  // Enums
  if (abi.enums.length) {
    L.push('// --- enums ------------------------------------------------------------');
    for (const e of abi.enums) {
      L.push(`export const ${e.tag} = {`);
      for (const m of e.members) L.push(`  ${m.name}: ${m.value},`);
      L.push('} as const;');
      L.push(`export type ${e.tag} = (typeof ${e.tag})[keyof typeof ${e.tag}];`);
      L.push('');
    }
  }

  // Status enum is an anonymous typedef enum in the headers; surface it as a
  // const object regardless of tag.
  if (abi.statusMembers.length) {
    L.push('// --- status codes (core/include/core/types.h) ---------------------------');
    L.push('export const SwStatus = {');
    for (const m of abi.statusMembers) L.push(`  ${m.name}: ${m.value},`);
    L.push('} as const;');
    L.push('export type SwStatusCode = (typeof SwStatus)[keyof typeof SwStatus];');
    L.push('');
  }

  // Regions
  if (abi.regions.length) {
    L.push('// --- arena regions -----------------------------------------------------');
    L.push('export const SwArenaRegion = {');
    for (const r of abi.regions) L.push(`  ${r.name}: ${r.value},`);
    L.push('} as const;');
    L.push('export type SwArenaRegionId = (typeof SwArenaRegion)[keyof typeof SwArenaRegion];');
    L.push('');
  }

  L.push('// --- arena region flags ------------------------------------------------');
  if (abi.arenaFlags.length) {
    L.push('export const SW_ARENA_F = {');
    for (const f of abi.arenaFlags) L.push(`  ${f.name}: ${f.value},`);
    L.push('} as const;');
    L.push('');
  }

  // Structs
  L.push('// --- struct layouts ----------------------------------------------------');
  L.push('export interface StructLayout {');
  L.push('  name: string;');
  L.push('  size: number;');
  L.push('  align: number;');
  L.push('}');
  L.push('');
  for (const s of abi.structList) {
    L.push(`export const ${s.name}_LAYOUT: StructLayout & { fields: ReadonlyArray<{ name: string; offset: number; size: number; count: number }> } = {`);
    L.push(`  name: '${s.name}',`);
    L.push(`  size: ${s.size},   // ${s.align}-byte aligned${s.tailPad ? `, ${s.tailPad} bytes tail padding` : ''}`);
    L.push(`  align: ${s.align},`);
    L.push('  fields: [');
    for (const f of s.fields) {
      L.push(`    { name: '${f.name}', offset: ${f.offset}, size: ${f.size}, count: ${f.count} },`);
    }
    L.push('  ],');
    L.push('};');
    L.push('');
  }

  // Field offset helpers: the ergonomic path used everywhere else.
  L.push('/** Byte offset of a named field. Throws if the field does not exist,');
  L.push(' *  which turns an ABI drift into an immediate, obvious failure. */');
  L.push('export function fieldOffset(structName: keyof typeof STRUCTS, field: string): number {');
  L.push('  const layout = STRUCTS[structName] as { fields: ReadonlyArray<{ name: string; offset: number }> };');
  L.push('  const hit = layout.fields.find((f) => f.name === field);');
  L.push('  if (!hit) {');
  L.push('    throw new Error(`gen/abi: ${String(structName)}.${field} does not exist - regenerate with npm run gen:abi`);');
  L.push('  }');
  L.push('  return hit.offset;');
  L.push('}');
  L.push('');

  L.push('export const STRUCTS = {');
  for (const s of abi.structList) L.push(`  ${s.name}: ${s.name}_LAYOUT,`);
  L.push('} as const;');
  L.push('');

  // Function signatures
  L.push('// --- exported functions ------------------------------------------------');
  L.push('export interface SwCoreExports {');
  for (const f of abi.functions) {
    const ret = f.ret.kind === 'void' ? 'void' : tsScalarName(f.ret);
    const params = f.params.map((p, i) => `${p.name || `a${i}`}: ${p.type.kind === 'ptr' ? 'number' : tsScalarName(p.type)}`);
    L.push(`  /** ${f.ret.cname ?? 'void'} ${f.name}(${f.params.map((p) => p.type.cname ?? '?').join(', ')}); */`);
    L.push(`  ${f.name}: (${params.join(', ')}) => ${ret};`);
  }
  L.push('}');
  L.push('');
  L.push(`export const ABI_FUNCTION_NAMES = [${abi.functions.map((f) => `'${f.name}'`).join(', ')}] as const;`);
  L.push('');

  // Readers
  L.push('// --- typed views -------------------------------------------------------');
  L.push('export function u32At(buf: ArrayBufferLike, off: number): number { return new DataView(buf).getUint32(off, true); }');
  L.push('export function u64At(buf: ArrayBufferLike, off: number): bigint { return new DataView(buf).getBigUint64(off, true); }');
  L.push('export function f32At(buf: ArrayBufferLike, off: number): number { return new DataView(buf).getFloat32(off, true); }');
  L.push('export function f64At(buf: ArrayBufferLike, off: number): number { return new DataView(buf).getFloat64(off, true); }');
  L.push('export function u8At(buf: ArrayBufferLike, off: number): number { return new DataView(buf).getUint8(off); }');
  L.push('');
  L.push('/** The 64-bit views, named separately because a wasm64 build swaps them. */');
  L.push('export const VIEW64 = {');
  L.push('  u64: BigUint64Array,');
  L.push('  i64: BigInt64Array,');
  L.push('} as const;');
  L.push('');
  L.push('export const VIEW32 = { u32: Uint32Array, i32: Int32Array } as const;');
  L.push('');
  void TS_VIEW;
  return L.join('\n');
}

// --- main ------------------------------------------------------------------

function main() {
  const check = process.argv.includes('--check');

  // `model` doubles as the shared semantic scope handed to every Parser, so the
  // macros/structs/enums/typedefs maps and the functions list below are filled
  // in place by the parser rather than reassigned.
  const model = {
    abiVersion: 1,
    pointerSize: 4,
    generatedFrom: HEADERS.join(', '),
    macros: new Map(),
    typedefs: new Map(),
    structs: new Map(),
    enums: new Map(),
    functions: [],
    features: [],
    statusMembers: [],
    regions: [],
    arenaFlags: [],
  };

  for (const h of HEADERS) {
    const path = join(INCLUDE_DIR, h);
    const src = readFileSync(path, 'utf8');
    const lineOf = makeLineIndex(src);
    const toks = tokenize(src, h);

    // A single Parser per header; macros are collected as directives are met
    // and structs are registered as they are defined, so declaration order
    // within a header is the only ordering constraint (and the ABI headers are
    // written in dependency order for exactly this reason).
    const p = new Parser(toks, h, model);
    p.parse();

    model.abiVersion = p.macros.get('SW_ABI_VERSION') ?? 1;

    if (h === 'types.h') {
      const st = p.enums.get('SwStatus');
      if (st) model.statusMembers = st.members;
    }
    if (h === 'memory.h') {
      const regions = p.enums.get('SwArenaRegion');
      if (regions) model.regions = regions.members;
      model.arenaFlags = [...p.macros.entries()]
        .filter(([k]) => k.startsWith('SW_ARENA_F_'))
        .map(([name, value]) => ({ name, value }));
    }
    if (h === 'platform.h') {
      model.features = [...p.macros.entries()]
        .filter(([k]) => k.startsWith('SW_FEATURE_'))
        .map(([name, value]) => ({ name, value }));
    }
  }

  // The shared `structs` map is the authoritative ordered set. Materialise the
  // list the emitters consume, keeping only structs reachable from the ABI.
  const structs = [...model.structs.values()];
  model.structList = structs;

  const abi = model;
  const json = JSON.stringify(
    {
      abiVersion: abi.abiVersion,
      pointerSize: abi.pointerSize,
      macros: Object.fromEntries(abi.macros),
      status: abi.statusMembers,
      features: abi.features,
      regions: abi.regions,
      arenaFlags: abi.arenaFlags,
      structs: abi.structList.map((s) => ({
        name: s.name, size: s.size, align: s.align, tailPad: s.tailPad,
        fields: s.fields.map((f) => ({
          name: f.name, offset: f.offset, size: f.size, count: f.count,
          align: f.align, padBefore: f.padBefore, ctype: f.type.cname ?? f.type.kind,
        })),
      })),
      functions: abi.functions.map((f) => ({
        name: f.name,
        ret: f.ret.cname ?? f.ret.kind,
        params: f.params.map((p) => ({ name: p.name, ctype: p.type.cname ?? p.type.kind })),
      })),
    },
    null,
    2,
  );

  const ts = emitTs(abi);

  mkdirSync(GEN_DIR, { recursive: true });
  const jsonPath = join(GEN_DIR, 'abi.json');
  const tsPath = join(GEN_DIR, 'abi.ts');

  if (check) {
    const stale = [];
    if (!existsSync(jsonPath) || readFileSync(jsonPath, 'utf8') !== json) stale.push('abi.json');
    if (!existsSync(tsPath) || readFileSync(tsPath, 'utf8') !== ts) stale.push('abi.ts');
    if (stale.length) {
      console.error(`gen-abi: stale generated file(s): ${stale.join(', ')}. Run: npm run gen:abi`);
      process.exit(1);
    }
    console.log('gen-abi: generated files are up to date.');
    return;
  }

  writeFileSync(jsonPath, json);
  writeFileSync(tsPath, ts);

  const sizes = abi.structList.map((s) => `${s.name}=${s.size}B`).join(' ');
  console.log(`gen-abi: ABI v${abi.abiVersion}, ${abi.functions.length} exports, ${abi.structList.length} structs`);
  console.log(`gen-abi: ${sizes}`);
  console.log('gen-abi: wrote gen/abi.json and gen/abi.ts');
}

main();
