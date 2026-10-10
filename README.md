# Moss

Moss is an AI-oriented reverse-engineering CLI written in Joyeer and managed
by joypm. It now inspects single JVM `.class` files, lists methods, and
disassembles selected method bytecode without reconstructing Java source.

**Status: working early-development JVM CLI, not a published release.**
The parser accepts Java 8..25 classfile versions (major 52..69, minor 0);
Java 25 preview requires explicit opt-in. Structural and native regression
tests pass on Windows ARM64. JDK/javap differential acceptance, other native
platforms, licensing, and release packaging remain open.

See the [CLI and schema contract](docs/jvm.md), the
[binary foundation](docs/binary.md), and the [remaining delivery plan](docs/plan.md).

## Capabilities

- Bounded 16 MiB input acquisition, checked big-endian readers, and stable
  diagnostics with file-byte offsets.
- Constant pools, fields, method descriptors, raw attribute spans, Code,
  exception regions, line/local-variable tables, and module metadata.
- All 198 permitted modern base opcodes, 11 modern wide forms, and both
  switch encodings; reserved and legacy `jsr`/`ret` forms reject.
- Raw bytes, instruction sizes, file and method-relative offsets, typed
  operands, checked constant references, and branch/debug/exception boundaries.
- Overload-safe name/descriptor or inventory-index method selection.
- Text, JSON, and NDJSON output, bounded pages, and exact 8 MiB output budget.
- Explicit ordinary-file output that never overwrites an existing destination.

No JAR/ZIP, DEX/APK, ELF/Mach-O/PE, CFG/SSA, class execution, or Java source
decompilation is implemented. This tool does not perform full JVM stack/type
verification. Uninterpreted attributes retain exact spans rather than invented
semantic results.

## Build, run, and test with joypm

The local native Windows ARM64 development toolchain:

```powershell
Set-Location 'C:\Source\Moss'
$joypm = 'C:\Source\joyeer-lang\out\build\arm64-debug\bin\joypm.exe'
$compiler = 'C:\Source\joyeer-lang\out\build\arm64-debug\bin\joyeer.exe'

& $joypm check --compiler $compiler --workspace .\workspace.toml
if ($LASTEXITCODE -ne 0) { throw 'Moss check failed' }

& $joypm build --compiler $compiler --workspace .\workspace.toml --module moss.app
if ($LASTEXITCODE -ne 0) { throw 'Moss build failed' }

& $joypm run --compiler $compiler --workspace .\workspace.toml --module moss.app -- `
    disasm 'tests\fixtures\jvm\Example25.class' --method wide
if ($LASTEXITCODE -ne 0) { throw 'Moss disassembly failed' }

& $joypm test --compiler $compiler --workspace .\workspace.toml
if ($LASTEXITCODE -ne 0) { throw 'Moss tests failed' }

& $joypm test --compiler $compiler --workspace .\workspace.toml --release
if ($LASTEXITCODE -ne 0) { throw 'Moss release tests failed' }
```

Machine-readable output should use a new destination file:

```powershell
& $joypm run --compiler $compiler --workspace .\workspace.toml --module moss.app -- `
    disasm 'tests\fixtures\jvm\Example25.class' --method sum `
    --descriptor '(II)I' --format json --output '.\sum.json'
if ($LASTEXITCODE -ne 0) { throw 'Moss output failed' }
```

The output must not already exist. File publication is fallible and exclusive,
not crash-atomic: a write failure can leave a partial new file. Input failures,
malformed bytecode, selection failures, and budget errors do not create output.

Current Joyeer `print` cannot report stdout write/flush failures. Text stdout
is for human inspection; JSON/NDJSON stdout requires `--unchecked-stdout`
and emits a warning on stderr. An automation success guarantee requires
`--output`, not the experimental pipe mode.

Compiler paths are explicit, not stored in the manifest. Use a matching
native toolchain on another machine; see the upstream
[building guide](../joyeer-lang/docs/building.md).

The project uses joypm 0.1.0: [workspace.toml](workspace.toml) lists nine
members, each with one schema-1 `joyeer.toml`. The root
[joyeer.toml](joyeer.toml) defines only `moss.app`; module sources and
dependencies are maintained next to their own code. `check` includes all
members, `build` selects bins, and `test` selects test modules. Use
`--module moss.app`, not the removed `--target moss`.
`run` and `test` always rebuild, with workspace-root cwd to preserve fixtures.
Outputs are ignored under `target`, with 128 fresh generations per
module/profile and no automatic cleanup, cache, or dependency fetching.
The [.gitignore](.gitignore) also excludes root-level native build artifacts
and local OS/editor files. Binary input fixtures and expected JSON data
remain versioned.
See [joypm](../joyeer-lang/docs/impl/joypm.md).

## Project layout

| Area | Responsibility |
|---|---|
| [src/binary/](src/binary/) | Checked coordinates/readers and bounded host acquisition |
| [src/model/](src/model/) | Format facts, instruction operands, IDs, diagnostics, byte/code-unit helpers |
| [src/jvm/](src/jvm/) | MUTF-8, descriptors, constant pool, class/attributes, and instruction decoder |
| [src/output/](src/output/) | Bounded text/JSON/NDJSON assembly |
| [src/cli.joyeer](src/cli.joyeer), [src/cli/](src/cli/) | Options, exact selection, pages, query orchestration |
| [src/main.joyeer](src/main.joyeer) | Diagnostics, native exit boundary, exclusive output |
| [tests/](tests/) | Explicit native suites, self-authored binary fixtures, process integration |

All product code is Joyeer. The existing
[Swift Moss engine](../decompify/Packages/Moss) is reference material, not a
runtime or build dependency.

## Validation

On 2026-10-10, native Windows ARM64 Debug and Release builds and joypm checks
passed. Each full native test run passed:

- 673 binary foundation checks.
- 1475 JVM/classfile/decoder/query/output checks.
- 10 CLI help/version and argument checks.

The [process integration suite](tests/jvm/integration.cjs) passed **678 checks**
against each Debug/Release executable, including 217 opcode/encoding cases,
Unicode and isolated-surrogate inventory selection, JSON/NDJSON shapes,
malformed mutations, exact pages, maximum Code length, metadata/text budgets,
and byte-exact 8 MiB output including LF.

An additional read-only smoke run decoded all 16 methods in three existing
compiled Swift-repository fixtures (major 52 and 60); none were copied into
Moss. An older-preview record fixture rejected under the explicit version
policy rather than being silently accepted. This is not javap differential
evidence or an imported regression corpus.

Run the integration suite against the explicit artifact path printed by a
successful joypm build:

```powershell
$moss = 'C:\Source\Moss\target\debug\moss.app\build-1\moss.exe'
& 'C:\Program Files\nodejs\node.exe' '.\tests\jvm\integration.cjs' $moss
if ($LASTEXITCODE -ne 0) { throw 'Moss integration failed' }
```

The example generation is local evidence, not a stable `latest` alias.
Node uses only its standard library and is a development/test prerequisite,
not a product dependency. Durable class fixtures are checked in, so the
ordinary joypm native suites do not require Node or a JDK.

The module/workspace configuration migration preserves the same product
sources and test fixtures. With the updated joypm 0.1.0, all nine members check and
Debug/Release native tests retain the same 2158 checks per profile.

No JDK was found in this environment, so the optional gate is **not executed**:

```powershell
& 'C:\Program Files\nodejs\node.exe' '.\tests\jvm\integration.cjs' `
    $moss --javap 'C:\your-jdk\bin\javap.exe'
```

The script compares javap method-descriptor instruction offsets/mnemonics.
Real javac-generated class coverage and deeper differential facts remain
release-hardening work. Self-authored structural fixtures are not proof of
executable stack correctness.

## Redistribution

No license has been selected for this project. Do not assume licensing or
fixture permissions transfer from Swift Moss. Resolve project licensing,
third-party notices, and native toolchain/product inventories before release.
