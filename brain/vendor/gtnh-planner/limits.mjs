// Runtime policy, not a modification of upstream mathematics. Fixed release limits.
export const STRUCTURAL_LIMITS = Object.freeze({
  nodes: 1024,
  edges: 4096,
  ports: 8192,
  storages: 1024,
  constraints: 4096,
  links: 16384,
  lpColumns: 4096,
  lpRows: 8192,
  lpNonzeros: 131072,
  lpDenseCells: 8_000_000,
  simplexTableauCells: 4_000_000,
});
