/** Composition root: the NAS analyzer with the Discogs + Photolib plugins loaded. `npm run archive:analyzer` starts this. */
import { startAnalyzer } from '../archive/analyzer/daemon';
import { discogsPlugin } from './analyzer-plugin';
import { photolibPlugin } from '../photolib/analyzer-plugin';

startAnalyzer({ plugins: [discogsPlugin(), photolibPlugin()] });
