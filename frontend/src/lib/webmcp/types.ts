/**
 * Shared types for the ShadowBroker agent tool layer.
 *
 * One registry of tools serves two consumers:
 *  - WebMCP (`navigator.modelContext`) so any browser agent can query the board;
 *  - the in-page agent chat (OpenAI-style tool calling over the same registry).
 */

/** Minimal JSON-Schema subset the registry validates against. */
export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaProperty;
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface LiveBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** What the tools may touch. Everything is injected so tests run without a page. */
export interface ToolContext {
  /** The live data store (the same object the map renders). Read-only. */
  readStore: () => Readonly<Record<string, unknown>>;
  /** Committed map viewport, or null at world scale. */
  getBounds: () => LiveBounds | null;
  /** Which map layers are currently switched on. */
  getActiveLayers: () => Readonly<Record<string, boolean>>;
  /** Map-view actions — the ONLY mutations a tool may perform. */
  map: {
    flyTo: (lat: number, lng: number, zoom?: number) => void;
    setLayer: (layer: string, enabled: boolean) => void;
  };
  /** Same-origin GET returning parsed JSON (tools never POST). */
  fetchJson: (url: string, signal?: AbortSignal) => Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /** false only for map-view actions (fly_to, toggle_layer). Data access is always read-only. */
  readOnly: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolContext, signal?: AbortSignal) => Promise<unknown>;
}

export interface ToolCallResult {
  ok: boolean;
  /** Bounded, secret-redacted JSON-serialisable payload. */
  result?: unknown;
  error?: string;
}
