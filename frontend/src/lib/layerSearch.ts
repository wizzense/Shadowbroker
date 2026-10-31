/**
 * Layer search — pure filtering for the DATA LAYERS panel.
 *
 * A layer row matches when every whitespace-separated token of the query is
 * found (case-insensitive) in the row's name, source or id, or in its
 * section's label. "Only active" keeps rows whose layer is switched on.
 */

export interface SearchableLayer {
  id: string;
  name: string;
  source?: unknown;
}

export interface SearchableSection<L extends SearchableLayer = SearchableLayer> {
  id: string;
  label: string;
  layers: L[];
}

export interface LayerFilterOptions {
  query: string;
  onlyActive: boolean;
  activeLayers: Record<string, unknown>;
}

/** Split a query into lower-case tokens; empty query → no tokens. */
export function tokenizeLayerQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function haystackFor(layer: SearchableLayer, sectionLabel: string): string {
  const source = typeof layer.source === 'string' ? layer.source : '';
  return `${layer.name} ${source} ${layer.id} ${sectionLabel}`.toLowerCase();
}

/** True when a filter would hide anything (search text or only-active). */
export function isLayerFilterActive(options: Pick<LayerFilterOptions, 'query' | 'onlyActive'>): boolean {
  return options.onlyActive || tokenizeLayerQuery(options.query).length > 0;
}

/**
 * Filter sections down to the layer rows that match. Sections with no
 * matching rows are dropped. Returns the input unchanged when no filter is set.
 */
export function filterLayerSections<S extends SearchableSection>(
  sections: S[],
  { query, onlyActive, activeLayers }: LayerFilterOptions,
): S[] {
  const tokens = tokenizeLayerQuery(query);
  if (!onlyActive && tokens.length === 0) return sections;
  const out: S[] = [];
  for (const section of sections) {
    const layers = section.layers.filter((layer) => {
      if (onlyActive && !activeLayers[layer.id]) return false;
      if (tokens.length === 0) return true;
      const hay = haystackFor(layer, section.label);
      return tokens.every((t) => hay.includes(t));
    });
    if (layers.length > 0) out.push({ ...section, layers } as S);
  }
  return out;
}
