/** Composition root: the NAS analyzer with the Discogs plugin loaded. `npm run archive:analyzer` starts this. */
import { startAnalyzer } from '../archive/analyzer/daemon';
import { discogsPlugin } from './analyzer-plugin';

startAnalyzer({ plugins: [discogsPlugin()] });
