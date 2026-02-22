#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getTolkCompilerVersion, runTolkCompiler } from '@ton/tolk-js';

const server = new McpServer(
  {
    name: 'tolk-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// ─── TOOLS ───────────────────────────────────────

server.tool(
  'get_compiler_version',
  'Returns the version string of the Tolk compiler (WASM build from @ton/tolk-js). ' +
  'Use this to verify the compiler is available and check its version before compiling.',
  async () => {
  const version = await getTolkCompilerVersion();
  return { content: [{ type: 'text', text: `Tolk compiler version: ${version}` }] };
});

// @ts-ignore: MCP SDK type instantiation depth issue with Zod schemas
server.tool(
  'compile_tolk',
  'Compiles Tolk smart contract source code using @ton/tolk-js. ' +
  'Provide source files as a map of filename→content. The entrypoint file must be included. ' +
  'Standard library imports (@stdlib/*) are resolved automatically. ' +
  'Returns compiled Fift code, BoC (Bag of Cells) in base64, and the code hash.',
  {
    entrypointFileName: z
      .string()
      .describe('The main .tolk file to compile (e.g., "main.tolk")'),
    sources: z
      .any()
      .describe(
        'Object mapping filename → source code content. Must include the entrypoint file. ' +
        'Example: {"main.tolk": "fun main(): int { return 0; }"}'
      ),
    optimizationLevel: z
      .number()
      .optional()
      .describe('Optimization level 0-2 (default: 2). 0 = no optimization, 2 = full optimization'),
    withStackComments: z
      .boolean()
      .optional()
      .describe('Include stack layout comments in Fift output (default: false). Useful for debugging'),
    experimentalOptions: z
      .string()
      .optional()
      .describe('Space-separated experimental compiler flags (advanced usage)'),
  },
  async (args) => {
  const { entrypointFileName, optimizationLevel, withStackComments, experimentalOptions } = args;
  const sources = args.sources as Record<string, string>;

  if (!sources[entrypointFileName]) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `Error: entrypoint file "${entrypointFileName}" not found in sources. ` +
          `Available files: ${Object.keys(sources).join(', ')}`,
      }],
    };
  }

  const result = await runTolkCompiler({
    entrypointFileName,
    fsReadCallback: (path: string) => {
      const normalized = path.startsWith('./') ? path.slice(2) : path;
      if (sources[normalized] !== undefined) return sources[normalized];
      if (sources[path] !== undefined) return sources[path];
      throw new Error(`File not found: ${path} (available: ${Object.keys(sources).join(', ')})`);
    },
    optimizationLevel: optimizationLevel ?? 2,
    withStackComments: withStackComments ?? false,
    experimentalOptions: experimentalOptions ?? '',
  });

  if (result.status === 'error') {
    return {
      isError: true,
      content: [{ type: 'text', text: `Compilation error:\n${result.message}` }],
    };
  }

  const lines = [
    '## Compilation Successful',
    '',
    `**Code Hash:** \`${result.codeHashHex}\``,
    `**BoC Size:** ${Math.ceil(result.codeBoc64.length * 3 / 4)} bytes`,
    '',
    '### Fift Code',
    '```fift',
    result.fiftCode,
    '```',
    '',
    '### BoC (Base64)',
    '```',
    result.codeBoc64,
    '```',
  ];

  if (result.stderr) {
    lines.push('', '### Compiler Warnings', '```', result.stderr, '```');
  }

  if (result.sourcesSnapshot.length > 0) {
    lines.push('', '### Sources Snapshot');
    for (const s of result.sourcesSnapshot) {
      lines.push(`- \`${s.filename}\` (${s.contents.length} chars)`);
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
});

// @ts-ignore: MCP SDK type instantiation depth issue with Zod schemas
server.tool(
  'check_tolk_syntax',
  'Validates Tolk smart contract source code without returning the full compiled output. ' +
  'Returns either "OK" with the code hash, or a detailed error message. ' +
  'Faster feedback loop for iterative development.',
  {
    entrypointFileName: z
      .string()
      .describe('The main .tolk file to check (e.g., "main.tolk")'),
    sources: z
      .any()
      .describe('Object mapping filename → source code content'),
  },
  async (args) => {
  const { entrypointFileName } = args;
  const sources = args.sources as Record<string, string>;

  if (!sources[entrypointFileName]) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `Error: entrypoint file "${entrypointFileName}" not found in sources.`,
      }],
    };
  }

  const result = await runTolkCompiler({
    entrypointFileName,
    fsReadCallback: (path: string) => {
      const normalized = path.startsWith('./') ? path.slice(2) : path;
      if (sources[normalized] !== undefined) return sources[normalized];
      if (sources[path] !== undefined) return sources[path];
      throw new Error(`File not found: ${path}`);
    },
    optimizationLevel: 2,
  });

  if (result.status === 'error') {
    return {
      isError: true,
      content: [{ type: 'text', text: `Syntax/compilation error:\n${result.message}` }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `OK — code hash: ${result.codeHashHex}` +
        (result.stderr ? `\nWarnings:\n${result.stderr}` : ''),
    }],
  };
});

// ─── RESOURCES ───────────────────────────────────

const TOLK_EXAMPLES: Record<string, { title: string; description: string; code: string }> = {
  'hello-world': {
    title: 'Hello World',
    description: 'Minimal Tolk contract that stores and returns a number',
    code: `// Simple counter contract in Tolk

global storedValue: int;

fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) {
    if (msgBody.isEndOfSlice()) { return; }
    var op = msgBody.loadMessageOp();

    if (op == 1) { // increment
        storedValue += 1;
    }
    if (op == 2) { // get value (will be in c5)
        var msg = beginCell()
            .storeMessageOp(3)
            .storeInt(storedValue, 64)
            .endCell();
    }
}

get fun getValue(): int {
    return storedValue;
}
`,
  },
  'wallet': {
    title: 'Simple Wallet',
    description: 'Basic wallet contract with owner authentication',
    code: `// Simple wallet contract

global owner: int;
global seqno: int;

fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) {
    // Accept all internal messages (top up)
}

fun onExternalMessage(inMsg: slice) {
    var signature = inMsg.loadBitsAsSlice(512);
    var cs = inMsg;
    var msgSeqno = cs.loadUint(32);
    var validUntil = cs.loadUint(32);

    assert(msgSeqno == seqno, 33);
    assert(now() <= validUntil, 34);
    assert(checkSignature(sliceHash(cs), signature, owner), 35);

    acceptExternalMessage();
    seqno += 1;

    // Process send requests from the message body
    while (!cs.isEndOfSlice()) {
        var mode = cs.loadUint(8);
        var msg = cs.loadRef();
        sendRawMessage(msg, mode);
    }
}

get fun seqno(): int {
    return seqno;
}
`,
  },
  'jetton': {
    title: 'Jetton (Token) Basics',
    description: 'Skeleton of a Jetton (fungible token) contract',
    code: `// Jetton wallet skeleton (TEP-74)

global balance: int;
global ownerAddress: slice;
global jettonMasterAddress: slice;

fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) {
    if (msgBody.isEndOfSlice()) { return; }
    var op = msgBody.loadMessageOp();
    var queryId = msgBody.loadUint(64);

    if (op == 0xf8a7ea5) { // transfer
        // Parse transfer details
        var amount = msgBody.loadCoins();
        var toOwner = msgBody.loadAddress();
        // ... transfer logic
    }

    if (op == 0x595f07bc) { // burn
        var amount = msgBody.loadCoins();
        assert(amount > 0, 100);
        balance -= amount;
        // ... notify master about burn
    }
}

get fun getWalletData(): (int, slice, slice, cell) {
    return (balance, ownerAddress, jettonMasterAddress, getMyCode());
}
`,
  },
};

server.resource(
  'tolk-language-reference',
  'tolk://reference',
  {
    description:
      'Tolk language quick reference — syntax, types, built-in functions, and key differences from FunC',
    mimeType: 'text/markdown',
  },
  async () => ({
    contents: [{
      uri: 'tolk://reference',
      mimeType: 'text/markdown',
      text: TOLK_REFERENCE,
    }],
  })
);

for (const [name, example] of Object.entries(TOLK_EXAMPLES)) {
  server.resource(
    `tolk-example-${name}`,
    `tolk://examples/${name}`,
    {
      description: example.description,
      mimeType: 'text/plain',
    },
    async () => ({
      contents: [{
        uri: `tolk://examples/${name}`,
        mimeType: 'text/plain',
        text: `// ${example.title}\n// ${example.description}\n\n${example.code}`,
      }],
    })
  );
}

// ─── PROMPTS ─────────────────────────────────────

server.prompt(
  'write_smart_contract',
  'Generates a prompt to write a TON smart contract in Tolk language. ' +
  'Describe what the contract should do and get a complete implementation.',
  {
    description: z.string().describe('What the smart contract should do'),
    features: z
      .string()
      .optional()
      .describe('Comma-separated list of features (e.g., "owner auth, upgradeable, jetton")'),
  },
  async (args) => ({
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text:
          `Write a TON smart contract in Tolk language.\n\n` +
          `## Requirements\n${args.description}\n\n` +
          (args.features ? `## Features\n${args.features}\n\n` : '') +
          `## Guidelines\n` +
          `- Use Tolk syntax (not FunC) — see the tolk://reference resource for language details\n` +
          `- Include proper message handling (onInternalMessage, onExternalMessage if needed)\n` +
          `- Add get-methods for reading contract state\n` +
          `- Handle errors with assert() and meaningful error codes\n` +
          `- Follow TEP standards if applicable (TEP-62 for NFT, TEP-74 for Jetton)\n\n` +
          `After writing the code, use the compile_tolk tool to verify it compiles successfully.`,
      },
    },
  ],
}));

server.prompt(
  'review_smart_contract',
  'Generates a prompt to review and analyze a Tolk smart contract for bugs, ' +
  'security issues, gas optimization, and best practices.',
  {
    code: z.string().describe('The Tolk source code to review'),
  },
  async (args) => ({
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text:
          `Review this TON smart contract written in Tolk:\n\n` +
          '```tolk\n' + args.code + '\n```\n\n' +
          `Analyze the following aspects:\n` +
          `1. **Security** — reentrancy, unauthorized access, integer overflow, replay attacks\n` +
          `2. **Gas optimization** — unnecessary operations, storage efficiency\n` +
          `3. **Correctness** — message handling, state management, edge cases\n` +
          `4. **Best practices** — TON/Tolk conventions, TEP compliance if applicable\n` +
          `5. **Missing functionality** — error handling, get-methods, bounce handling\n\n` +
          `Use the check_tolk_syntax tool to verify the code compiles, then provide your review.`,
      },
    },
  ],
}));

// ─── TOLK LANGUAGE REFERENCE ─────────────────────

const TOLK_REFERENCE = `# Tolk Language Reference

Tolk is a smart contract language for TON blockchain — a successor to FunC with modern syntax.

## Key Differences from FunC
- \`fun\` instead of \`() method_name()\`
- \`var\` for local variables, \`global\` for globals
- \`import\` instead of \`#include\`
- \`get fun\` for get-methods (instead of \`method_id\`)
- \`assert(condition, errorCode)\` instead of \`throw_unless(errorCode, condition)\`
- Logical operators: \`&&\`, \`||\`, \`!\` (instead of \`&\`, \`|\`, \`~\`)
- Null safety: \`?.chainCall()\` and \`!!\` operators
- No implicit variable declarations

## Types
- \`int\` — 257-bit signed integer (TVM native)
- \`cell\` — TVM cell (up to 1023 bits + 4 refs)
- \`slice\` — cell slice for reading
- \`builder\` — cell builder for writing
- \`tuple\` — TVM tuple
- \`cont\` — continuation
- \`bool\` — actually int, but true/false keywords available

## Function Syntax
\`\`\`tolk
fun functionName(param1: int, param2: cell): int {
    return param1 + 1;
}

// Get-method (accessible from outside)
get fun getBalance(): int {
    return balance;
}
\`\`\`

## Standard Entry Points
\`\`\`tolk
fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) { }
fun onExternalMessage(inMsg: slice) { }
fun onTickTock(isTock: bool) { }
\`\`\`

## Common Operations
\`\`\`tolk
// Cell building
var b = beginCell().storeUint(0, 32).storeCoins(amount).endCell();

// Slice reading
var op = body.loadUint(32);
var amount = body.loadCoins();
var addr = body.loadAddress();

// Sending messages
sendRawMessage(msg, mode);

// Hash
var h = cellHash(c);
var h = sliceHash(s);

// Assert
assert(condition, 100); // throws 100 if false
\`\`\`

## Standard Library (@stdlib)
Import with: \`import "@stdlib/tvm-dicts"\`
Available: tvm-dicts, tvm-lowlevel, lisp-lists, deploy-utils, gas-payments, content

## Compilation
Use the compile_tolk tool to compile your code. Provide all files as a sources map.
`;

// ─── START ───────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
