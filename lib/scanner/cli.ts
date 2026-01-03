#!/usr/bin/env node
/**
 * MoleBoard CLI Scanner
 * Run scans from the command line
 */

import * as path from 'path';
import * as fs from 'fs';
import { scanDirectory, saveScanCache } from './scanner';

// Parse command line args
const args = process.argv.slice(2);
const rootPath = args[0] || '~/Projects';
const force = args.includes('--force') || args.includes('-f');

async function main() {
  console.log(`MoleBoard Scanner`);
  console.log(`=================`);
  console.log(`Scanning: ${rootPath}`);
  console.log(`Force: ${force}`);
  console.log(``);

  // Expand ~ to home directory
  const expandedPath = rootPath.replace(/^~/, process.env.HOME || '');

  // Verify path exists
  if (!fs.existsSync(expandedPath)) {
    console.error(`Error: Path not found: ${expandedPath}`);
    process.exit(1);
  }

  console.log(`Starting scan...`);
  const startTime = Date.now();

  try {
    const summary = await scanDirectory(expandedPath, {
      progressCallback: (current, total) => {
        if (current % 100 === 0) {
          process.stdout.write(`\rScanned ${current}/${total} files...`);
        }
      },
    });

    console.log(`\n`);
    console.log(`Scan Complete!`);
    console.log(`==============`);
    console.log(`Total Size: ${formatBytes(summary.totalSize)}`);
    console.log(`Files: ${summary.fileCount}`);
    console.log(`Folders: ${summary.folderCount}`);
    console.log(`Time: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    console.log(``);

    // Show largest files
    console.log(`Top 5 Largest Files:`);
    summary.largestFiles.slice(0, 5).forEach((file, i) => {
      console.log(`  ${i + 1}. ${file.name} (${formatBytes(file.size)})`);
    });

    console.log(``);

    // Show media heatmap
    console.log(`Media Heatmap:`);
    const heatmap = summary.mediaHeatmap;
    console.log(`  Video: ${heatmap.video.count} files (${formatBytes(heatmap.video.size)})`);
    console.log(`  Images: ${heatmap.image.count} files (${formatBytes(heatmap.image.size)})`);
    console.log(`  Design: ${heatmap.design.count} files (${formatBytes(heatmap.design.size)})`);
    console.log(`  Audio: ${heatmap.audio.count} files (${formatBytes(heatmap.audio.size)})`);
    console.log(`  Archives: ${heatmap.archive.count} files (${formatBytes(heatmap.archive.size)})`);
    console.log(`  Code: ${heatmap.code.count} files (${formatBytes(heatmap.code.size)})`);

    // Save to cache
    saveScanCache(rootPath, summary);
    console.log(`\nCached to: .moleboard/cache.json`);

  } catch (error) {
    console.error(`Scan failed:`, error);
    process.exit(1);
  }
}

function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

main();
