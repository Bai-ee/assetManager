/** Pillar taxonomy + organizer bucket names. A dependency-free leaf so both
 * `scheme.ts` and `../clients.ts` can share it without an import cycle;
 * `scheme.ts` re-exports everything here. */
export const PILLARS = ['was-there', 'made-this', 'found-this', 'how-made', 'thirty-years', 'building-now'] as const;
export type Pillar = typeof PILLARS[number];
export const UNSORTED = '_unsorted';

export function isValidPillar(value: string | null | undefined): value is Pillar {
  return !!value && (PILLARS as readonly string[]).includes(value);
}

/** A per-collection bucket folder name: a pillar, `_unsorted`, or `_meta`. */
export function isCollectionBucketName(value: string | null | undefined): boolean {
  return isValidPillar(value) || value === UNSORTED || value === '_meta';
}
