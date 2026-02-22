import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// We can't easily import the whole server module (it auto-connects stdio),
// so we test the tolk-js functions directly + use a fresh MCP client for integration.
import { getTolkCompilerVersion, runTolkCompiler } from '@ton/tolk-js';

describe('tolk-js direct', () => {
  it('returns compiler version', async () => {
    const version = await getTolkCompilerVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('compiles a simple contract', async () => {
    const result = await runTolkCompiler({
      entrypointFileName: 'main.tolk',
      fsReadCallback: (path: string) => {
        if (path === 'main.tolk') {
          return 'fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) { }\n\nget fun hello(): int { return 42; }';
        }
        throw new Error(`File not found: ${path}`);
      },
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.codeHashHex).toBeTruthy();
      expect(result.codeBoc64).toBeTruthy();
      expect(result.fiftCode).toContain('PROC');
      expect(result.fiftCode).toContain('42 PUSHINT');
    }
  });

  it('reports compilation errors', async () => {
    const result = await runTolkCompiler({
      entrypointFileName: 'bad.tolk',
      fsReadCallback: (path: string) => {
        if (path === 'bad.tolk') return 'fun broken() { invalid syntax }';
        throw new Error(`File not found: ${path}`);
      },
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('error');
    }
  });

  it('compiles with optimization level 0', async () => {
    const result = await runTolkCompiler({
      entrypointFileName: 'main.tolk',
      fsReadCallback: (path: string) => {
        if (path === 'main.tolk') {
          return 'fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) { }\n\nget fun value(): int { return 1 + 2; }';
        }
        throw new Error(`File not found: ${path}`);
      },
      optimizationLevel: 0,
    });

    expect(result.status).toBe('ok');
  });

  it('compiles with stack comments', async () => {
    const result = await runTolkCompiler({
      entrypointFileName: 'main.tolk',
      fsReadCallback: (path: string) => {
        if (path === 'main.tolk') {
          return 'fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) { }';
        }
        throw new Error(`File not found: ${path}`);
      },
      withStackComments: true,
    });

    expect(result.status).toBe('ok');
  });

  it('compiles multi-file contracts', async () => {
    const files: Record<string, string> = {
      'main.tolk': 'import "./helper.tolk";\n\nfun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) { var x = helperFn(); }\n\nget fun result(): int { return helperFn(); }',
      'helper.tolk': 'fun helperFn(): int { return 123; }',
    };

    const result = await runTolkCompiler({
      entrypointFileName: 'main.tolk',
      fsReadCallback: (path: string) => {
        const normalized = path.startsWith('./') ? path.slice(2) : path;
        if (files[normalized]) return files[normalized];
        if (files[path]) return files[path];
        throw new Error(`File not found: ${path}`);
      },
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.fiftCode).toContain('123 PUSHINT');
    }
  });
});

describe('MCP server integration', () => {
  let client: Client;
  let mcpServer: McpServer;

  beforeAll(async () => {
    // Build a fresh server for testing
    const { z } = await import('zod');
    const tolkJs = await import('@ton/tolk-js');

    mcpServer = new McpServer(
      { name: 'tolk-mcp-server-test', version: '1.0.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    mcpServer.tool(
      'get_compiler_version',
      'Returns Tolk compiler version',
      async () => {
        const version = await tolkJs.getTolkCompilerVersion();
        return { content: [{ type: 'text' as const, text: `Tolk compiler version: ${version}` }] };
      }
    );

    // @ts-ignore
    mcpServer.tool(
      'compile_tolk',
      'Compile Tolk source',
      {
        entrypointFileName: z.string(),
        sources: z.any(),
      },
      async (args: any) => {
        const sources = args.sources as Record<string, string>;
        const result = await tolkJs.runTolkCompiler({
          entrypointFileName: args.entrypointFileName,
          fsReadCallback: (path: string) => {
            const n = path.startsWith('./') ? path.slice(2) : path;
            if (sources[n] !== undefined) return sources[n];
            if (sources[path] !== undefined) return sources[path];
            throw new Error(`File not found: ${path}`);
          },
        });

        if (result.status === 'error') {
          return { isError: true, content: [{ type: 'text' as const, text: result.message }] };
        }
        return {
          content: [{ type: 'text' as const, text: `Hash: ${result.codeHashHex}\nBoC: ${result.codeBoc64}` }],
        };
      }
    );

    mcpServer.resource(
      'tolk-reference',
      'tolk://reference',
      { description: 'Tolk reference', mimeType: 'text/markdown' },
      async () => ({
        contents: [{ uri: 'tolk://reference', mimeType: 'text/markdown', text: '# Tolk Reference' }],
      })
    );

    mcpServer.prompt(
      'write_smart_contract',
      'Write a TON smart contract',
      { description: z.string() },
      async (args: any) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Write: ${args.description}` } }],
      })
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '1.0.0' });

    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await mcpServer.close();
  });

  it('lists tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('get_compiler_version');
    expect(names).toContain('compile_tolk');
  });

  it('gets compiler version via MCP', async () => {
    const result = await client.callTool({ name: 'get_compiler_version', arguments: {} });
    const text = (result.content as any)[0].text;
    expect(text).toMatch(/Tolk compiler version: \d+\.\d+\.\d+/);
  });

  it('compiles via MCP', async () => {
    const result = await client.callTool({
      name: 'compile_tolk',
      arguments: {
        entrypointFileName: 'main.tolk',
        sources: {
          'main.tolk': 'fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) { }\n\nget fun hello(): int { return 42; }',
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as any)[0].text;
    expect(text).toContain('Hash:');
    expect(text).toContain('BoC:');
  });

  it('handles compilation errors via MCP', async () => {
    const result = await client.callTool({
      name: 'compile_tolk',
      arguments: {
        entrypointFileName: 'bad.tolk',
        sources: { 'bad.tolk': 'invalid code here' },
      },
    });

    expect(result.isError).toBeTruthy();
  });

  it('lists resources', async () => {
    const result = await client.listResources();
    expect(result.resources.length).toBeGreaterThan(0);
    expect(result.resources.some((r) => r.uri === 'tolk://reference')).toBe(true);
  });

  it('reads reference resource', async () => {
    const result = await client.readResource({ uri: 'tolk://reference' });
    expect(result.contents[0].text).toContain('Tolk');
  });

  it('lists prompts', async () => {
    const result = await client.listPrompts();
    expect(result.prompts.some((p) => p.name === 'write_smart_contract')).toBe(true);
  });

  it('gets prompt', async () => {
    const result = await client.getPrompt({
      name: 'write_smart_contract',
      arguments: { description: 'A simple counter' },
    });
    expect(result.messages.length).toBeGreaterThan(0);
    expect((result.messages[0].content as any).text).toContain('counter');
  });
});
