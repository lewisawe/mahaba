/**
 * WebMCP ambient types.
 *
 * Transcribed from the WebMCP Community Group draft IDL
 * (https://webmachinelearning.github.io/webmcp/) with one deliberate
 * divergence, verified against Chrome 152 in probe/FINDINGS.md:
 *
 *   The spec declares `executeTool(RegisteredTool, optional object inputObject = {})`.
 *   Chrome ships a required JSON *string*. Passing an object stringifies to
 *   "[object Object]" and rejects with "Failed to parse input arguments".
 *
 * The signature below matches the shipped implementation, because that is what
 * the code has to call.
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  annotations?: ToolAnnotations;
  execute: (inputObject: unknown, options: { signal: AbortSignal }) => Promise<unknown>;
}

export interface RegisterToolOptions {
  /** Origins outside this document allowed to see the tool. Defaults to same-origin only. */
  exposedTo?: string[];
  /** Aborting this signal unregisters the tool. This is the only revocation mechanism. */
  signal?: AbortSignal;
}

export interface GetToolsOptions {
  fromOrigins?: string[];
}

export interface RegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  window: Window;
  origin: string;
  annotations?: ToolAnnotations;
}

export interface ModelContext extends EventTarget {
  registerTool(tool: ModelContextTool, options?: RegisterToolOptions): Promise<void>;
  getTools(options?: GetToolsOptions): Promise<RegisteredTool[]>;
  /** Chrome takes a required JSON string, not an object. Returns a JSON string. */
  executeTool(
    tool: RegisteredTool,
    inputArguments: string,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
  ontoolchange: ((this: ModelContext, event: Event) => unknown) | null;
}

declare global {
  interface Document {
    /** Undefined unless WebMCP is enabled and the document is origin-isolated. */
    readonly modelContext?: ModelContext;
  }

  interface Window {
    /** True when the agent cluster is origin-keyed, which WebMCP requires. */
    readonly originAgentCluster?: boolean;
  }
}
