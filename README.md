# tolk-mcp-server

MCP server for the [Tolk](https://docs.ton.org/v3/documentation/smart-contracts/tolk/overview) smart contract compiler. Compile, validate, and explore TON smart contracts from any MCP-compatible AI assistant (Claude Desktop, Cursor, Windsurf, etc.).

## Features

**Tools:**
- `get_compiler_version` — Returns the Tolk compiler version
- `compile_tolk` — Compiles Tolk source code to Fift + BoC with full compiler options (optimization level, stack comments, experimental flags)
- `check_tolk_syntax` — Quick syntax validation without full output

**Resources:**
- `tolk://reference` — Tolk language quick reference (syntax, types, differences from FunC)
- `tolk://examples/hello-world` — Counter contract example
- `tolk://examples/wallet` — Wallet contract example
- `tolk://examples/jetton` — Jetton (token) contract skeleton

**Prompts:**
- `write_smart_contract` — Guided prompt for writing a new TON smart contract
- `review_smart_contract` — Guided prompt for security review and optimization analysis

## Quick Start

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tolk": {
      "command": "npx",
      "args": ["-y", "tolk-mcp-server"]
    }
  }
}
```

### Cursor / Windsurf

Add to your MCP settings:

```json
{
  "tolk": {
    "command": "npx",
    "args": ["-y", "tolk-mcp-server"]
  }
}
```

### From Source

```bash
git clone https://github.com/oxgeneral/tolk-mcp-server.git
cd tolk-mcp-server
npm install
npm run build
npm start
```

## Usage Examples

### Compile a contract

```
> Use the compile_tolk tool to compile this contract:

fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) {
}

get fun hello(): int {
    return 42;
}
```

The tool returns:
- Fift assembly code
- BoC (Bag of Cells) in base64 — ready for deployment
- Code hash — unique identifier of the compiled code
- Warnings (if any)

### Check syntax quickly

```
> Use check_tolk_syntax to validate my contract before deploying
```

Returns OK + code hash, or a detailed error with line/column info.

### Multi-file contracts

Pass all files in the `sources` parameter:

```json
{
  "entrypointFileName": "main.tolk",
  "sources": {
    "main.tolk": "import \"./utils.tolk\";\nfun onInternalMessage(...) { ... }",
    "utils.tolk": "fun helper(): int { return 1; }"
  }
}
```

Standard library imports (`@stdlib/*`) are resolved automatically by the compiler.

## Compiler Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `optimizationLevel` | 0-2 | 2 | 0 = none, 1 = basic, 2 = full |
| `withStackComments` | bool | false | Add stack layout comments to Fift output |
| `experimentalOptions` | string | "" | Space-separated experimental compiler flags |

## Requirements

- Node.js >= 18
- No external dependencies beyond npm packages

## Development

```bash
npm install
npm run dev    # Run with tsx (hot reload)
npm run build  # Compile TypeScript
npm test       # Run tests
```

## License

MIT
