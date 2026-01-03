import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Types for run history
export interface MoleRunRecord {
  id: string;
  command: string;
  args: string[];
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
  stdout: string;
  stderr: string;
  riskLevel: 'Safe' | 'Medium' | 'Destructive';
  userId?: string;
}

// Paths for persistence
const RUNS_DIR = path.join(process.cwd(), '.moleboard');
const RUNS_FILE = path.join(RUNS_DIR, 'runs.json');

/**
 * Ensure the runs directory and file exist
 */
function ensureRunsFile(): void {
  if (!fs.existsSync(RUNS_DIR)) {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
  }
  if (!fs.existsSync(RUNS_FILE)) {
    fs.writeFileSync(RUNS_FILE, '[]', 'utf-8');
  }
}

/**
 * Read all runs from history
 */
export function readRunsHistory(): MoleRunRecord[] {
  ensureRunsFile();
  try {
    const data = fs.readFileSync(RUNS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * Save runs to history (keeps last 100)
 */
function saveRunsHistory(runs: MoleRunRecord[]): void {
  // Keep only the last 100 runs
  const trimmed = runs.slice(0, 100);
  fs.writeFileSync(RUNS_FILE, JSON.stringify(trimmed, null, 2), 'utf-8');
}

/**
 * Create a new run record and persist it
 */
export function createRunRecord(
  command: string,
  args: string[],
  riskLevel: 'Safe' | 'Medium' | 'Destructive'
): MoleRunRecord {
  const runs = readRunsHistory();
  const run: MoleRunRecord = {
    id: crypto.randomUUID(),
    command,
    args,
    startTime: new Date().toISOString(),
    status: 'running',
    stdout: '',
    stderr: '',
    riskLevel,
  };

  runs.unshift(run);
  saveRunsHistory(runs);
  return run;
}

/**
 * Update a run record
 */
export function updateRunRecord(
  id: string,
  updates: Partial<MoleRunRecord>
): MoleRunRecord | null {
  const runs = readRunsHistory();
  const index = runs.findIndex((r) => r.id === id);

  if (index === -1) return null;

  runs[index] = { ...runs[index], ...updates };
  saveRunsHistory(runs);
  return runs[index];
}

/**
 * Run a Mole command and stream output
 * Returns the run ID and a writable stream for stdout
 */
export function runMoleCommand(
  command: string,
  args: string[],
  riskLevel: 'Safe' | 'Medium' | 'Destructive',
  onOutput?: (output: string, isStdout: boolean) => void
): { runId: string; process: ChildProcess } {
  const runId = createRunRecord(command, args, riskLevel).id;

  // Find the mo binary
  const moPath = process.env.MOLE_PATH || 'mo';

  const childProcess = spawn(moPath, [command, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    cwd: process.cwd(),
  });

  let stdout = '';
  let stderr = '';

  childProcess.stdout?.on('data', (data) => {
    const text = data.toString();
    stdout += text;
    if (onOutput) onOutput(text, true);
    updateRunRecord(runId, { stdout });
  });

  childProcess.stderr?.on('data', (data) => {
    const text = data.toString();
    stderr += text;
    if (onOutput) onOutput(text, false);
    updateRunRecord(runId, { stderr });
  });

  childProcess.on('close', (code) => {
    const endTime = new Date().toISOString();
    updateRunRecord(runId, {
      status: code === 0 ? 'completed' : 'failed',
      exitCode: code || undefined,
      endTime,
    });
  });

  childProcess.on('error', (err) => {
    updateRunRecord(runId, {
      status: 'failed',
      stderr: stderr + `\nError: ${err.message}`,
      endTime: new Date().toISOString(),
    });
  });

  return { runId, process: childProcess };
}

/**
 * Get a run by ID
 */
export function getRunById(id: string): MoleRunRecord | null {
  const runs = readRunsHistory();
  return runs.find((r) => r.id === id) || null;
}

/**
 * Get recent runs
 */
export function getRecentRuns(limit = 20): MoleRunRecord[] {
  const runs = readRunsHistory();
  return runs.slice(0, limit);
}

/**
 * Get runs by status
 */
export function getRunsByStatus(status: MoleRunRecord['status']): MoleRunRecord[] {
  const runs = readRunsHistory();
  return runs.filter((r) => r.status === status);
}

/**
 * Clear old completed runs
 */
export function clearOldRuns(keepCount = 50): number {
  const runs = readRunsHistory();
  const completed = runs.filter((r) => r.status === 'completed');
  const removed = Math.max(0, completed.length - keepCount);

  if (removed > 0) {
    const kept = runs.filter((r) => r.status !== 'completed').slice(0, keepCount);
    const toKeep = [...runs.filter((r) => r.status === 'completed').slice(0, keepCount - (runs.length - completed.length)), ...kept];
    saveRunsHistory(toKeep);
  }

  return removed;
}
