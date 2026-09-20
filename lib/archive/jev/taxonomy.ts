import taxonomyData from './taxonomy.json';

/**
 * The six questions Jev answers about an archive asset, vendored from HITLOOP
 * (`features/x-content-inventory/jev-taxonomy.js` via
 * `scripts/x-content/export-jev-taxonomy.mjs`). THIS file is a copy of a build
 * output, not the source — regenerate `taxonomy.json` from HITLOOP whenever the
 * vocabulary changes, or the two sides silently disagree.
 */
export interface JevTaxonomyQuestion {
  id: string;
  question: string;
  choices: string[];
  fills: string;
  gate: boolean;
  openEnded: boolean;
  blocked: string | null;
}

export interface JevTaxonomy {
  generatedAt: string;
  source: string;
  reviewBands: { AUTO_CONFIRM: number; QUICK_REVIEW: number };
  questions: JevTaxonomyQuestion[];
}

export const JEV_TAXONOMY = taxonomyData as JevTaxonomy;
export const JEV_QUESTIONS: JevTaxonomyQuestion[] = JEV_TAXONOMY.questions;
