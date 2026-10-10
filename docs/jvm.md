# JVM CLI and Output Contract

## Status and scope

Single-class inspection, method enumeration, and lossless bytecode decoding
are implemented. The current structural policy accepts major 52..69
(Java 8..25), minor 0. Major 69/minor 65535 is accepted only with
`--allow-preview`; earlier preview versions reject even with that flag.

This is a native Windows ARM64-verified early-development implementation.
JDK differential acceptance and other native platforms remain unverified.
Version parsing is not proof that every language construct produced by every
compiler has been exercised.

No analyzed code is executed. No classpath is fetched or resolved. The tool
does not perform full stack/type verification, resolve member linkage,
reconstruct Java source, or interpret every optional attribute.

## Commands

```text
moss --help
moss --version
moss inspect <file.class> [options]
moss methods <file.class> [--offset <index>] [--limit <count>] [options]
moss disasm <file.class> --method <name> [--descriptor <descriptor>] [options]
moss disasm <file.class> --method-index <index> [options]
```

Options:

| Option | Contract |
|---|---|
| `--format text/json/ndjson` | Default text; invalid formats reject |
| `--output <new-file>` | Exclusive byte-exact UTF-8/ASCII file output; never replace existing file |
| `--unchecked-stdout` | Explicit experimental JSON/NDJSON stdout without `--output` |
| `--allow-preview` | Allow only Java 25 preview |
| `--method <name>` | Exact case-sensitive UTF-16 name matching from UTF-8 argv |
| `--descriptor <descriptor>` | Exact descriptor; only with a named method selector |
| `--method-index <index>` | Zero-based physical method inventory index, instead of a name |
| `--offset <number>` | Methods: inventory index; disasm: method-relative byte offset |
| `--limit <number>` | 1..10000 records, default 1000 |

The input path immediately follows the command. Options use separate
nonempty values. Singleton duplicates, extra positional arguments, unknown
options, unsupported command combinations, negative/out-of-range integers,
and numeric overflow fail with `cli.usage`. Help/version must be used alone.

`inspect` is a complete class inventory and does not accept page options or
method selectors. `methods` pages physical method records and does not
accept method selectors. `disasm` selects exactly one method and pages its
decoded instructions.

Named overload ambiguity fails with `query.ambiguous-method`; no fallback
overload is chosen. Method index selection also handles code-unit names that
cannot be expressed in UTF-8 command-line arguments, such as isolated
surrogates or embedded NUL. Names containing those units remain lossless
in the output.

### Paging

For method enumeration, offsets range from zero through methodCount.
methodCount yields an empty terminal page. Each record includes
`methodIndex`; pages remain in classfile order.

For disassembly, an offset must be an instruction start, not a byte in an
operand, wide instruction, or switch table. The exact exclusive method Code
length is accepted as an empty terminal page. Native/abstract methods have
no Code and yield an empty page at offset zero.

`hasMore` and `nextOffset` are explicit. Instruction continuation offsets
are method byte coordinates; method continuation offsets are inventory
indexes. Successful pagination does not claim all records were included.
All selected method bytecode is decoded/checked before a page is serialized,
so a malformed instruction after the page boundary still fails.

## Parser and decoder behavior

The classfile reader checks:

- Magic, version/minor policy, counts, byte budgets, and final file position.
- Constant indexes, expected tags, modern tag/version constraints,
  MethodHandle references, dynamic bootstrap indexes, and dual-slot constants.
- Strict Modified UTF-8 byte encoding, preserving UTF-16 code units including
  surrogate pairs and isolated surrogates; no replacement decoding.
- Class/member names, descriptors, receiver/parameter slots, duplicate
  name+descriptor members, selected flag incompatibilities, and Code presence.
- Code length/maxLocals, attribute subregions, exception ranges, line/local
  tables, ConstantValue, Exceptions, SourceFile, BootstrapMethods, and
  Module/ModulePackages structure.

Other attributes, including StackMapTable, annotations, signatures, record
metadata, and most compiler-specific attributes, retain exact name/header/body
spans. Their interior semantics are not validated or prettified. Known
attributes handled by this reader must consume exactly their declared body.
The implementation is not a complete JVMS access-flag/attribute verifier.

`inspect` and `methods` validate classfile metadata but do not decode every
method. `disasm` additionally validates the entire selected Code stream.
Output's `validation` field states that boundary.

The decoder covers every permitted modern base opcode and all modern wide
forms, preserving raw/effective opcode, exact bytes/size, and signed operands.
`jsr`, `jsr_w`, `ret`, wide ret, reserved opcodes, malformed padding lengths,
or truncated operands reject. Switch padding values are not constrained;
alignment is relative to the method, not the file.

Static checks include constant/opcode compatibility, local slot width,
invokeinterface count and reserved bytes, invokedynamic reserved bytes,
array type/dimensions, return-descriptor compatibility, switch counts/ordering,
instruction-boundary branches, exception/debug boundaries, and final
fallthrough rejection. Runtime stack contents, hierarchy, and linkage are
not inferred.

## Schema version 1

All JSON is emitted as ASCII with JSON escapes for non-ASCII code units.
UTF-16 surrogates remain `\uXXXX` escapes; raw modified UTF-8 is independently
recoverable from the constant's bytes. This avoids lossy conversion or
requiring an unsupported Joyeer general Unicode encoder.

The complete JSON envelope includes:

```text
schemaVersion: 1
artifactId
inputPath, inputBytes
query
validation
class
method (selected disasm method, or null)
constants / fields / attributes (inspect only)
methods (inspect or methods)
instructions (disasm only)
page { coordinate, count, hasMore, nextOffset }
complete: true
diagnostics: []
```

`validation` is `classfile-structure` for inventory queries and
`classfile-and-selected-bytecode-structure` for disassembly.
`complete` means that the chosen query/page serialized successfully, not
complete JVM verification, whole-file disassembly, or guaranteed stdout
delivery.

Class metadata retains internal name, major/minor, preview flag, access
flags, superclass, interfaces, and inventory counts. Members include exact
name, descriptor, methodId, methodIndex/fieldIndex, accessFlags, fileOffset,
attributes, and Code or null.

Code includes its attribute offset, maxStack/maxLocals, raw byte range,
exception regions, line/local-variable metadata, and nested attribute spans.
Exception ends are exclusive and catchType index zero is explicitly catch-all.

Constants retain index/tag/kind, fileOffset/size/bytesHex, text, resolved
owner/name/descriptor where applicable, raw bitsHex, integerValue, bootstrap
index, MethodHandle kind, and referenced indexes. A 64-bit constant's second
slot is `Unusable`, not a second usable constant. Float/Double/Long raw bit
patterns use hexadecimal strings rather than lossy JSON floating-point
numbers. Null fields mean not applicable, not a failed read.

Instruction fields:

```text
schemaVersion, artifactId, methodId
methodOffset, fileOffset, size
rawOpcode, effectiveOpcode, mnemonic, wide
bytesHex
operands
constantReferences
branchTargets
diagnostics
```

Operand kinds are `immediate`, `local`, `constant`, `target`, `arrayType`,
`dimensions`, `count`, `defaultTarget`, and `switchTarget`. Target coordinates
are method byte offsets. Switch operands retain every key and target; no
entry is silently discarded.

artifactId is `jvm:` followed by fixed-width UTF-16 hex of the internal class
name. methodId adds similarly encoded method name and descriptor, separated
by colons. These are stable logical names, not content hashes; changed
classfiles with the same name retain their logical ID. Bind facts to input
bytes/path/offsets rather than treating an ID as a checksum or source owner.

### NDJSON and text

NDJSON emits a `metadata` record, typed `constant`, `field`, `attribute`,
`method`, or `instruction` records with a `data` object, and a final
`completion` record carrying the page/complete state. All records are buffered
within the same output limit before publication; this is not streaming I/O.

Text shows human-readable instruction lines with method/file coordinates,
size, raw bytes, typed operands, and constant references. Class/member
metadata is retained in labeled JSON fragments. It is not intended to be
byte-for-byte javap formatting.

## Budgets and failures

| Resource | Inclusive policy |
|---|---|
| Input | 16777216 bytes, acquired with one extra sentinel |
| Code | 1..65535 bytes |
| Requested page | 1..10000 records |
| Serialized output | 8388608 bytes including final LF |
| Total Utf8 payloads | 1048576 encoded bytes before decoded-array allocation |
| Parsed metadata records | 262144 charged records |

Counts are validated against remaining bytes before iteration/allocation.
Metadata/text budgets are deliberate early-development domain limits;
an otherwise structurally valid class can reject with `jvm.resource-limit`.
Likewise, very long IDs or repeated constant text can make a page exceed
output budget. Reduce the page where possible; no truncation or success-shaped
fallback is used. Individual constants/instructions are never abbreviated.

The output ceiling includes exactly one LF. Process tests accept an exact
8388608-byte JSON file and reject a larger result without creating output.
The byte ceiling is not a total heap, time, or filesystem confinement guarantee.

Exit statuses:

- 0: successful command/query publication under the chosen delivery mode.
- 2: command-line usage/selection syntax error.
- 1: acquisition, malformed/unsupported class or code, query resolution,
  budget, output, or diagnostic-write failure.

Query lookup errors are domain status 1, not command syntax errors.
Stable diagnostic code, file offset when available, context, and message
are written to stderr. Native input/output error codes are retained in
messages. No stdout success document is emitted after an analysis error.

`--output` uses exclusive `writeFileNew` and may leave a partial new file
after a host write/close failure; it is not atomic publication or durability.
Existing files are never replaced, including the input. No temp-directory
or artifact cleanup API is needed in the product.

Human stdout and `--unchecked-stdout` use the current unchecked `print`.
Windows text-mode newline translation and broken-pipe errors are outside
that mode's exact byte/success guarantee. A warning accompanies the experimental
structured mode; use `--output` for automated results.

## Verification and remaining gates

On 2026-10-10, native ARM64 joypm check/build/test passed in Debug and Release:
673 binary checks, 1475 JVM checks, and 10 CLI checks each. The process
[integration suite](../tests/jvm/integration.cjs) passed 678 checks against
each executable, covering 217 encoding cases, all supported version numbers,
malformed inputs, Unicode/index selection, exact paging, JSON/NDJSON/text
facts, exclusive writes, and exact budgets.

Fixtures are [self-authored](../tests/fixtures/jvm/README.md). The native
suite truncates an entire example class at every byte position. The process
suite adds targeted malformed cases and deterministic mutations; this is not
an exhaustive fuzzing or security proof.

An additional read-only smoke decoded 16 methods in three existing
Java classfiles from the Swift checkout (major 52 and 60), including string
switch code. No fixture was copied or registered as an external dependency.
An older-preview record input rejected as outside policy. This does not
replace compiler-generated/differential regression coverage.

No JDK was installed/found. `--javap <explicit-path>` in the integration
suite enables the currently unexecuted offsets/mnemonics comparison. Real
javac-produced and broader compiler-idiom corpus validation remain open.

One measured maximum-method run used 65644 input bytes and decoded 65535
instructions, returning an empty terminal page. While other integration
runs were active, Debug took 93.21 ms with sampled peak working set 23.07 MiB;
Release took 100.07 ms and 22.82 MiB. These include process launch, are not
an isolated comparative benchmark, and do not establish a throughput target.

The toolchain was the local native ARM64 Debug compiler
`out\build\arm64-debug\bin\joyeer.exe` (build timestamp 2026-10-09);
joypm's local build timestamp was 2026-10-10. Current source HEAD is not
claimed as an exact rebuild identity for those binaries.

Remaining release gates: installed-JDK differential/real-compiler corpus,
broader native platforms, full peak/allocation measurements, licensing,
third-party/product inventories, and packaging. Fallible stdout remains a
Joyeer capability gap. JAR, DEX, native backends, CFG/SSA, and decompilation
remain separate later phases.
