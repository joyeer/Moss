'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { ClassBuilder, cat, u1, u2, u4, i4 } = require('./fixtures.cjs');

const root = path.resolve(__dirname, '..', '..');
const fixtures = path.join(root, 'tests', 'fixtures', 'jvm');
if (![3, 5].includes(process.argv.length) || (process.argv.length === 5 && process.argv[3] !== '--javap')) {
  throw new Error('usage: node integration.cjs <moss-executable> [--javap <explicit-javap-path>]');
}
const executable = path.resolve(process.argv[2]);
const javap = process.argv.length === 5 ? path.resolve(process.argv[4]) : null;
const work = path.join(root, 'target', `jvm-integration-${process.pid}-${crypto.randomUUID()}`);
fs.mkdirSync(work);
const owned = new Set();
let sequence = 0;
let checks = 0;

function invoke(args) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `process signaled: ${result.signal}`);
  assert.ok([0, 1, 2].includes(result.status), `unexpected status ${result.status}: ${result.stderr}`);
  return result;
}
function check(condition, label) { assert.ok(condition, label); checks++; }
function file(name) { return path.join(fixtures, name); }
function temporary(bytes, suffix = '.class') {
  const location = path.join(work, `input-${sequence++}${suffix}`);
  fs.writeFileSync(location, bytes, { flag: 'wx' });
  owned.add(location);
  return location;
}
function saved(args, format = 'json') {
  const output = path.join(work, `output-${sequence++}.${format}`);
  const result = invoke([...args, '--format', format, '--output', output]);
  if (fs.existsSync(output)) owned.add(output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const raw = fs.readFileSync(output);
  assert.ok(raw.length <= 8388608);
  assert.equal(raw.at(-1), 10);
  checks++;
  return format === 'json' ? JSON.parse(raw.toString('utf8')) :
    raw.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
}
function failure(args, code, status = 1, output = true) {
  const destination = path.join(work, `failure-${sequence++}.json`);
  const result = invoke(output ? [...args, '--format', 'json', '--output', destination] : args);
  if (fs.existsSync(destination)) owned.add(destination);
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(code), result.stderr);
  if (output) assert.equal(fs.existsSync(destination), false, 'failed query created output');
  checks++;
}
function mutated(source, offset, bytes) {
  const copy = Buffer.from(source);
  Buffer.from(bytes).copy(copy, offset);
  return temporary(copy);
}
function outline(bytes) {
  const pool = [null];
  let cursor = 10;
  for (let i = 1; i < bytes.readUInt16BE(8); i++) {
    const start = cursor;
    const tag = bytes[cursor++];
    let size;
    if (tag === 1) { size = 2 + bytes.readUInt16BE(cursor); }
    else if ([3, 4, 9, 10, 11, 12, 17, 18].includes(tag)) size = 4;
    else if ([5, 6].includes(tag)) size = 8;
    else if (tag === 15) size = 3;
    else size = 2;
    cursor += size;
    pool[i] = { start, tag, size: cursor - start };
    if ([5, 6].includes(tag)) { pool[++i] = null; }
  }
  return { pool, header: cursor };
}
function oneMethod(bytes, descriptor = '()V', options = {}) {
  const builder = new ClassBuilder('Malformed');
  builder.method('test', descriptor, bytes, { maxLocals: 8, ...options });
  return temporary(builder.bytes());
}
function validateRecords(data, bytes) {
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.complete, true);
  const starts = new Set(data.instructions.map(i => i.methodOffset));
  for (const row of data.instructions) {
    assert.equal(row.artifactId, data.artifactId);
    assert.equal(row.methodId, data.method.methodId);
    assert.equal(row.fileOffset, data.method.code.bytes.fileOffset + row.methodOffset);
    assert.equal(row.bytesHex, bytes.subarray(row.fileOffset, row.fileOffset + row.size).toString('hex'));
    assert.equal(row.rawOpcode, bytes[row.fileOffset]);
    assert.ok(row.size > 0);
    for (const target of row.branchTargets) assert.ok(starts.has(target), `bad target ${target}`);
  }
  checks++;
}

try {
  const sampleBytes = fs.readFileSync(file('Example25.class'));
  const sample = saved(['inspect', file('Example25.class')]);
  check(sample.class.name === 'Example' && sample.class.major === 69 && sample.class.methodCount === 10,
    'class identity and inventory');
  check(sample.fields[0].name === 'value' && sample.fields[0].descriptor === 'I', 'field inventory');
  check(sample.methods[7].code === null && sample.methods[8].code === null, 'native and abstract methods remain visible');
  check(sample.attributes.find(a => a.name === 'MossUnknown').body.size === 4, 'unknown attribute span is retained');
  for (let major = 52; major <= 69; major++) {
    const bytes = Buffer.from(sampleBytes);
    bytes.writeUInt16BE(major, 6);
    const parsed = saved(['inspect', temporary(bytes)]);
    check(parsed.class.major === major && parsed.class.minor === 0, `version ${major}`);
  }
  failure(['inspect', file('Preview.class')], 'jvm.unsupported-version');
  check(saved(['inspect', file('Preview.class'), '--allow-preview']).class.preview, 'preview opt-in');
  const oldPreview = Buffer.from(sampleBytes);
  oldPreview.writeUInt16BE(65535, 4);
  oldPreview.writeUInt16BE(65, 6);
  failure(['inspect', temporary(oldPreview), '--allow-preview'], 'jvm.unsupported-version');
  for (const major of [0, 51, 70, 65535]) {
    const bytes = Buffer.from(sampleBytes);
    bytes.writeUInt16BE(major, 6);
    failure(['inspect', temporary(bytes)], 'jvm.unsupported-version');
  }

  const constants = saved(['inspect', file('ConstantKinds.class')]);
  const indexes = JSON.parse(fs.readFileSync(file('constants.json'), 'utf8'));
  const byIndex = new Map(constants.constants.map(c => [c.index, c]));
  check(byIndex.get(indexes.stringText).text === 'quote" slash\\ nul\0 line\n \u4e2d \ud83d\ude00 lone\ud800',
    'MUTF-8 includes NUL, surrogate pair, and isolated surrogate');
  check(byIndex.get(indexes.long).bitsHex === 'ffffffffffffffff' &&
    byIndex.get(indexes.double).bitsHex === '8000000000000000' &&
    byIndex.get(indexes.float).bitsHex === '7fc00001', 'exact numeric bit patterns');
  check(byIndex.get(indexes.integer).integerValue === -2147483648, 'signed 32-bit constant');
  check(byIndex.get(indexes.long + 1).tag === 0 && byIndex.get(indexes.long + 1).size === 0, 'unusable slot');
  const constantCode = saved(['disasm', file('ConstantKinds.class'), '--method', 'constants']);
  validateRecords(constantCode, fs.readFileSync(file('ConstantKinds.class')));
  const module = saved(['inspect', file('Module.class')]);
  check(module.class.name === 'module-info' && module.class.superClass === null &&
    module.constants.some(c => c.tag === 19) && module.constants.some(c => c.tag === 20), 'module metadata');

  const unicodePath = path.join(work, '\u5206\u6790 input.class');
  fs.writeFileSync(unicodePath, fs.readFileSync(file('Unicode.class')), { flag: 'wx' });
  owned.add(unicodePath);
  const unicode = saved(['disasm', unicodePath, '--method', 'sum\u4e2d', '--descriptor', '(II)I']);
  check(unicode.inputPath === unicodePath && unicode.class.name === 'Example\u4e2d' &&
    unicode.method.name === 'sum\u4e2d', 'Unicode path, class, and method selection');
  const weird = saved(['disasm', file('WeirdNames.class'), '--method-index', '0']);
  check(weird.class.name === 'Nul\0Class' && weird.method.name === 'zero\0method',
    'NUL code units in legal JVM names are not replaced or rejected');
  check(saved(['disasm', file('WeirdNames.class'), '--method-index', '1']).method.name === '\ud800',
    'inventory-index selection reaches names not encodable in UTF-8 argv');

  const matrix = JSON.parse(fs.readFileSync(file('opcodes.json'), 'utf8'));
  for (const expected of matrix) {
    const data = saved(['disasm', file('OpcodeMatrix.class'), '--method', expected.name]);
    const row = data.instructions[expected.instructionIndex || 0];
    assert.equal(row.rawOpcode, expected.rawOpcode ?? expected.opcode, expected.name);
    assert.equal(row.effectiveOpcode, expected.opcode, expected.name);
    assert.equal(row.mnemonic, expected.mnemonic, expected.name);
    assert.equal(row.size, expected.size, expected.name);
    assert.equal(row.methodOffset, expected.methodOffset || 0, expected.name);
    assert.equal(row.wide, expected.rawOpcode === 196, expected.name);
    assert.deepEqual(row.operands, expected.operands, expected.name);
    checks++;
  }

  const full = saved(['disasm', file('Example25.class'), '--method', 'wide']);
  check(saved(['disasm', file('Example25.class'), '--method-index', '3']).method.methodId === full.method.methodId,
    'name and inventory-index selectors agree');
  validateRecords(full, sampleBytes);
  check(full.instructions[2].operands[1].value === -32768 && full.instructions[2].wide, 'wide iinc is not narrowed');
  let offset = 0;
  const paged = [];
  for (;;) {
    const page = saved(['disasm', file('Example25.class'), '--method', 'wide', '--offset', String(offset), '--limit', '2']);
    paged.push(...page.instructions);
    if (!page.page.hasMore) { assert.equal(page.page.nextOffset, null); break; }
    assert.ok(page.page.nextOffset > offset);
    offset = page.page.nextOffset;
  }
  assert.deepEqual(paged, full.instructions);
  checks++;
  const endPage = saved(['disasm', file('Example25.class'), '--method', 'wide', '--offset', '18']);
  check(endPage.instructions.length === 0 && !endPage.page.hasMore, 'terminal offset');
  const native = saved(['disasm', file('Example25.class'), '--method', 'nativeValue']);
  check(native.instructions.length === 0 && native.method.code === null, 'native method disassembly has no fabricated code');
  failure(['disasm', file('Example25.class'), '--method', 'sum'], 'query.ambiguous-method');
  failure(['disasm', file('Example25.class'), '--method', 'sum', '--descriptor', '()I'], 'query.method-not-found');
  failure(['disasm', file('Example25.class'), '--method-index', '10'], 'query.method-not-found');
  failure(['disasm', file('Example25.class'), '--method', 'wide', '--offset', '4'], 'query.invalid-offset');
  failure(['disasm', file('Example25.class'), '--method', 'wide', '--offset', '19'], 'query.invalid-offset');
  failure(['methods', file('Example25.class'), '--offset', '11'], 'query.invalid-offset');
  const methods = saved(['methods', file('Example25.class'), '--offset', '7', '--limit', '2']);
  check(methods.methods.length === 2 && methods.page.nextOffset === 9 &&
    methods.methods[0].methodIndex === 7 && methods.methods[1].methodIndex === 8, 'method-index pagination');
  const stream = saved(['disasm', file('Example25.class'), '--method', 'wide', '--limit', '2'], 'ndjson');
  check(stream[0].type === 'metadata' && stream.at(-1).type === 'completion' &&
    stream.filter(r => r.type === 'instruction').length === 2 && stream.at(-1).page.nextOffset === 7, 'NDJSON framing');
  check(invoke(['methods', file('Example25.class')]).stdout.includes('nativeValue'), 'human text output');
  const textInventory = invoke(['inspect', file('Example25.class')]);
  check(textInventory.stdout.includes('Field 0') && textInventory.stdout.includes('MossUnknown') &&
    textInventory.stdout.includes('"exceptions"'), 'text retains fields, attributes, and exception metadata');
  const unchecked = invoke(['methods', file('Example25.class'), '--format', 'json', '--unchecked-stdout']);
  check(unchecked.status === 0 && unchecked.stderr.includes('output.unchecked-stdout') &&
    JSON.parse(unchecked.stdout).complete, 'unchecked stdout is explicit and warned');
  failure(['methods', file('Example25.class'), '--format', 'json'], 'cli.usage', 2, false);
  for (const args of [
    ['disasm'], ['disasm', file('Example25.class')], ['unknown'], ['--help', 'extra'],
    ['methods', file('Example25.class'), '--limit', '0'],
    ['methods', file('Example25.class'), '--limit', '10001'],
    ['methods', file('Example25.class'), '--offset', '-1'],
    ['methods', file('Example25.class'), '--offset', '99999999999999999999999999999999'],
    ['methods', file('Example25.class'), '--limit', '1', '--limit', '2'],
    ['inspect', file('Example25.class'), '--offset', '0'],
    ['methods', file('Example25.class'), '--method', 'wide'],
    ['disasm', file('Example25.class'), '--method', 'wide', '--method-index', '3'],
    ['disasm', file('Example25.class'), '--method-index', '3', '--descriptor', '()I'],
    ['methods', file('Example25.class'), '--format', 'xml'],
    ['methods', file('Example25.class'), '--output'],
  ]) failure(args, 'cli.usage', 2, false);
  failure(['inspect', path.join(work, 'missing.class')], 'input.inspect-failed');
  failure(['inspect', work], 'input.not-regular');
  failure(['inspect', temporary(Buffer.alloc(0))], 'binary.truncated');
  failure(['inspect', temporary(Buffer.from('not a class'))], 'jvm.invalid-magic');

  const out = path.join(work, 'protected.json');
  fs.writeFileSync(out, 'preserve me', { flag: 'wx' });
  owned.add(out);
  const existing = invoke(['inspect', file('Example25.class'), '--format', 'json', '--output', out]);
  check(existing.status === 1 && existing.stdout === '' && existing.stderr.includes('output.write-failed') &&
    fs.readFileSync(out, 'utf8') === 'preserve me', 'existing output is never overwritten');

  const shape = outline(sampleBytes);
  failure(['inspect', mutated(sampleBytes, 8, [0, 0])], 'jvm.invalid-constant-count');
  failure(['inspect', mutated(sampleBytes, shape.pool[1].start, [255])], 'jvm.unsupported-constant-tag');
  for (const encoding of [[0], [128], [240], [193, 191], [224, 128, 128]]) {
    failure(['inspect', mutated(sampleBytes, shape.pool[1].start + 3, encoding)], 'jvm.invalid-mutf8');
  }
  failure(['inspect', mutated(sampleBytes, shape.pool[1].start + shape.pool[1].size - 1, [194])], 'binary.truncated');
  failure(['inspect', mutated(sampleBytes, shape.pool[2].start + 1, [0, 0])], 'jvm.invalid-constant-index');
  failure(['inspect', mutated(sampleBytes, shape.pool[2].start + 1, u2(2))], 'jvm.invalid-constant-tag');
  failure(['inspect', mutated(sampleBytes, shape.header + 2, [0, 0])], 'jvm.invalid-constant-index');
  failure(['inspect', mutated(sampleBytes, shape.header + 4, [0, 0])], 'jvm.invalid-super-class');
  failure(['inspect', mutated(sampleBytes, shape.header, u2(0x431))], 'jvm.invalid-class-flags');
  failure(['inspect', temporary(new ClassBuilder('java/lang/Object').bytes())], 'jvm.invalid-super-class');
  failure(['inspect', mutated(sampleBytes, sample.fields[0].fileOffset, u2(0x59))], 'jvm.invalid-member-flags');
  failure(['inspect', mutated(sampleBytes, sample.methods[1].fileOffset, u2(0x0b))], 'jvm.invalid-member-flags');
  failure(['inspect', temporary(cat(sampleBytes, [0]))], 'jvm.trailing-bytes');
  const constructor = sample.methods[0];
  failure(['inspect', mutated(sampleBytes, constructor.fileOffset, u2(0x101))], 'jvm.invalid-method');
  const wide = sample.methods[3].code;
  failure(['inspect', mutated(sampleBytes, wide.bytes.fileOffset - 4, u4(0))], 'jvm.invalid-code-length');
  failure(['inspect', mutated(sampleBytes, wide.bytes.fileOffset - 4, u4(65536))], 'jvm.invalid-code-length');
  failure(['inspect', mutated(sampleBytes, sample.methods[1].code.attributeOffset + 8, u2(1))], 'jvm.invalid-local-index');
  const duplicate = new ClassBuilder('Duplicates');
  duplicate.method('test', '()V', Buffer.from([177]));
  duplicate.method('test', '()V', Buffer.from([177]));
  failure(['inspect', temporary(duplicate.bytes())], 'jvm.duplicate-member');
  const noCode = new ClassBuilder('NoCode');
  noCode.method('test', '()V', null);
  failure(['inspect', temporary(noCode.bytes())], 'jvm.invalid-method-code');
  const dual = new ClassBuilder('Dual');
  dual.add(5, Buffer.alloc(8), 2);
  const dualBytes = dual.bytes();
  dualBytes.writeUInt16BE(dual.pool.length - 1, 8);
  failure(['inspect', temporary(dualBytes)], 'jvm.invalid-constant-count');

  const constantBytes = fs.readFileSync(file('ConstantKinds.class'));
  const constantShape = outline(constantBytes);
  failure(['inspect', mutated(constantBytes, constantShape.pool[indexes.handle].start + 1, [0])], 'jvm.invalid-method-handle');
  failure(['inspect', mutated(constantBytes, constantShape.pool[indexes.handle].start + 1, [8])], 'jvm.invalid-method-handle');
  failure(['inspect', mutated(constantBytes, constantShape.pool[indexes.dynamic].start + 1, u2(65535))], 'jvm.invalid-bootstrap');
  const oldDynamic = Buffer.from(constantBytes);
  oldDynamic.writeUInt16BE(52, 6);
  failure(['inspect', temporary(oldDynamic)], 'jvm.invalid-constant-version');
  const moduleBytes = fs.readFileSync(file('Module.class'));
  const moduleAttribute = module.attributes.find(a => a.name === 'Module');
  failure(['inspect', mutated(moduleBytes, moduleAttribute.body.fileOffset, u2(0))], 'jvm.invalid-constant-index');
  const caught = sample.methods[9].code;
  failure(['inspect', mutated(sampleBytes, caught.exceptions[0].fileOffset, u2(2))], 'jvm.invalid-exception-range');
  failure(['inspect', mutated(sampleBytes, caught.lines[0].fileOffset, u2(5))], 'jvm.invalid-debug-range');

  for (const bytes of [[202, 177], [254, 177], [255, 177], [168, 0, 0, 177], [169, 0, 177], [201, 0, 0, 0, 0, 177]]) {
    failure(['disasm', oneMethod(Buffer.from(bytes)), '--method', 'test'], 'jvm.invalid-opcode');
  }
  for (const bytes of [[196, 177], [196, 169, 0, 0, 177]]) {
    failure(['disasm', oneMethod(Buffer.from(bytes)), '--method', 'test'], 'jvm.invalid-wide');
  }
  for (const bytes of [[16], [17, 0], [196, 21, 0], [196, 132, 0, 0, 0], [200, 0, 0, 0]]) {
    failure(['disasm', oneMethod(Buffer.from(bytes)), '--method', 'test'], 'binary.truncated');
  }
  failure(['disasm', oneMethod(Buffer.from([0])), '--method', 'test'], 'jvm.fallthrough-end');
  failure(['disasm', oneMethod(Buffer.from([172])), '--method', 'test'], 'jvm.invalid-return');
  failure(['disasm', oneMethod(Buffer.from([21, 8, 177])), '--method', 'test'], 'jvm.invalid-local-index');
  failure(['disasm', oneMethod(Buffer.from([196, 21, 255, 255, 177]), '()V', { maxLocals: 65535 }),
    '--method', 'test'], 'jvm.invalid-local-index');
  failure(['disasm', oneMethod(Buffer.from([167, 0, 1, 177])), '--method', 'test'], 'jvm.invalid-branch-target');
  failure(['disasm', oneMethod(cat([200], i4(-2147483648), [177])), '--method', 'test'], 'jvm.invalid-branch-target');
  failure(['disasm', oneMethod(Buffer.from([188, 3, 177])), '--method', 'test'], 'jvm.invalid-array');
  failure(['disasm', oneMethod(Buffer.from([16, 0, 87, 177]), '()V', { handlers: [[0, 2, 1, 0]] }),
    '--method', 'test'], 'jvm.invalid-exception-range');
  failure(['disasm', oneMethod(cat([170, 0, 0, 0], i4(0), i4(-2147483648), i4(2147483647), [177])),
    '--method', 'test'], 'jvm.invalid-switch');
  failure(['disasm', oneMethod(cat([171, 0, 0, 0], i4(0), i4(-1), [177])),
    '--method', 'test'], 'jvm.invalid-switch');
  failure(['disasm', oneMethod(cat([171, 0, 0, 0], i4(0), i4(2), i4(1), i4(0), i4(1), i4(0), [177])),
    '--method', 'test'], 'jvm.invalid-switch');
  const matrixMeta = saved(['methods', file('OpcodeMatrix.class')]);
  const matrixBytes = fs.readFileSync(file('OpcodeMatrix.class'));
  const methodByName = new Map(matrixMeta.methods.map(m => [m.name, m]));
  failure(['disasm', mutated(matrixBytes, methodByName.get('op185').code.bytes.fileOffset + 4, [1]),
    '--method', 'op185'], 'jvm.invalid-invoke');
  failure(['disasm', mutated(matrixBytes, methodByName.get('op186').code.bytes.fileOffset + 3, [1]),
    '--method', 'op186'], 'jvm.invalid-invoke');
  failure(['disasm', mutated(matrixBytes, methodByName.get('op197').code.bytes.fileOffset + 3, [0]),
    '--method', 'op197'], 'jvm.invalid-array');
  failure(['disasm', mutated(matrixBytes, methodByName.get('op18').code.bytes.fileOffset + 1, [0]),
    '--method', 'op18'], 'jvm.invalid-constant-index');

  const large = new ClassBuilder('MaximumCode');
  const maximumCode = Buffer.alloc(65535);
  maximumCode[65534] = 177;
  large.method('large', '()V', maximumCode, { maxLocals: 0 });
  const largePath = temporary(large.bytes());
  const largePage = saved(['disasm', largePath, '--method', 'large', '--limit', '10000']);
  check(largePage.instructions.length === 10000 && largePage.page.nextOffset === 10000, 'maximum code length and page ceiling');
  const terminal = saved(['disasm', largePath, '--method', 'large', '--offset', '65535']);
  check(terminal.instructions.length === 0, 'maximum terminal offset');
  const textBudget = new ClassBuilder('TextBudget');
  for (let index = 0; index < 17; index++) {
    textBudget.add(1, cat(u2(65535), Buffer.alloc(65535, 65 + index)));
  }
  failure(['inspect', temporary(textBudget.bytes())], 'jvm.resource-limit');
  const metadataBudget = new ClassBuilder('MetadataBudget');
  metadataBudget.method('first', '()V', null, { flags: 0x109 });
  const opaque = metadataBudget.attr('Opaque', Buffer.alloc(0));
  for (let index = 0; index < 4; index++) {
    metadataBudget.method(`metadata${index}`, '()V', null,
      { flags: 0x109, attributes: Array.from({ length: 65535 }, () => opaque) });
  }
  failure(['methods', temporary(metadataBudget.bytes()), '--limit', '1'], 'jvm.resource-limit');
  const budget = new ClassBuilder('OutputBudget');
  budget.method('x'.repeat(4096), '()V', cat(Buffer.alloc(1000), [177]), { maxLocals: 0 });
  failure(['disasm', temporary(budget.bytes()), '--method', 'x'.repeat(4096)], 'output.budget-exceeded');

  const exactInput = path.join(work, 'exact-output.class');
  owned.add(exactInput);
  const nativeCount = 1200;
  let sharedLength = 500;
  let paddingLength = 32;
  let nulCount = 0;
  function exactCandidate() {
    const builder = new ClassBuilder('ExactOutput');
    const padding = cat(Buffer.alloc(paddingLength, 89),
      ...Array.from({ length: nulCount }, () => Buffer.from([192, 128])));
    builder.add(1, cat(u2(padding.length), padding));
    for (let index = 0; index < nativeCount; index++) {
      builder.method('x'.repeat(sharedLength), `()LType${index};`, null, { flags: 0x109 });
    }
    fs.writeFileSync(exactInput, builder.bytes());
    const output = path.join(work, `exact-${sequence++}.json`);
    const result = invoke(['inspect', exactInput, '--format', 'json', '--output', output]);
    if (fs.existsSync(output)) owned.add(output);
    if (result.status === 1 && result.stderr.includes('final newline would exceed')) {
      assert.equal(fs.existsSync(output), false);
      return { length: 8388609 };
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    return fs.readFileSync(output);
  }
  let exact = exactCandidate();
  sharedLength += Math.floor((8388608 - exact.length - 512) / (5 * nativeCount + 3));
  exact = exactCandidate();
  paddingLength += Math.floor((8388608 - exact.length - 100) / 3);
  exact = exactCandidate();
  for (let attempt = 0; exact.length !== 8388608 && attempt < 12; attempt++) {
    const difference = 8388608 - exact.length;
    const nuls = ((difference % 3) + 3) % 3;
    const ascii = (difference - 10 * nuls) / 3;
    assert.ok(paddingLength + ascii >= 0);
    nulCount += nuls;
    paddingLength += ascii;
    exact = exactCandidate();
  }
  assert.equal(exact.length, 8388608, 'inclusive output ceiling must include the final newline');
  assert.equal(JSON.parse(exact.toString('utf8')).complete, true);
  checks++;
  paddingLength++;
  const oversized = new ClassBuilder('ExactOutput');
  const padding = cat(Buffer.alloc(paddingLength, 89),
    ...Array.from({ length: nulCount }, () => Buffer.from([192, 128])));
  oversized.add(1, cat(u2(padding.length), padding));
  for (let index = 0; index < nativeCount; index++) {
    oversized.method('x'.repeat(sharedLength), `()LType${index};`, null, { flags: 0x109 });
  }
  fs.writeFileSync(exactInput, oversized.bytes());
  failure(['inspect', exactInput], 'output.budget-exceeded');

  let seed = 0x13579bdf;
  for (let index = 0; index < 64; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const changed = Buffer.from(sampleBytes);
    const at = seed % changed.length;
    changed[at] ^= 1 << (index % 8);
    const input = temporary(changed);
    const output = path.join(work, `fuzz-${index}.json`);
    const result = invoke(['inspect', input, '--format', 'json', '--output', output]);
    if (fs.existsSync(output)) owned.add(output);
    assert.equal(result.stdout, '');
    if (result.status === 0) {
      assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).complete, true);
    } else {
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes('moss:'), result.stderr);
      assert.equal(fs.existsSync(output), false);
    }
    checks++;
  }

  if (javap) {
    const result = spawnSync(javap, ['-v', '-c', '-p', '-s', file('Example25.class')],
      { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    let declaration = '';
    let current = null;
    const groups = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (/^  .*[);]$/.test(line.trimEnd())) declaration = line.trim();
      const descriptor = /^\s+descriptor:\s+(\S+)/.exec(line);
      if (descriptor) {
        const match = /([\w$]+)\(/.exec(declaration);
        current = match ? { name: match[1] === 'Example' ? '<init>' : match[1], descriptor: descriptor[1], rows: [] } : null;
        if (current) groups.push(current);
      }
      const instruction = /^\s+(\d+):\s+([a-z][a-z0-9_]*)\b/.exec(line);
      if (instruction && current) {
        let mnemonic = instruction[2];
        if (/^(?:[ilfda](?:load|store)|iinc)_w$/.test(mnemonic)) mnemonic = mnemonic.slice(0, -2);
        current.rows.push({ offset: Number(instruction[1]), mnemonic });
      }
    }
    for (const group of groups) {
      if (!group.rows.length) continue;
      const data = saved(['disasm', file('Example25.class'), '--method', group.name, '--descriptor', group.descriptor]);
      assert.deepEqual(data.instructions.map(i => ({ offset: i.methodOffset, mnemonic: i.mnemonic })), group.rows);
      checks++;
    }
    console.log('PASS: javap differential instruction offsets/mnemonics');
  } else {
    console.log('JDK differential gate not executed: supply --javap <explicit path>.');
  }
  const timings = [];
  for (let index = 0; index < 5; index++) {
    const start = performance.now();
    const result = invoke(['disasm', file('Example25.class'), '--method', 'wide']);
    assert.equal(result.status, 0, result.stderr);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  console.log(`Latency sample: ${sampleBytes.length} input bytes, 5 decoded instructions, median ${timings[2].toFixed(2)} ms (includes process launch).`);
  console.log(`PASS: ${checks} JVM/CLI integration checks, including ${matrix.length} opcode/encoding cases.`);
} finally {
  for (const location of owned) fs.unlinkSync(location);
  fs.rmdirSync(work);
}
