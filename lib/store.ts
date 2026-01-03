import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Types for our store
interface ScanRoot {
  path: string;
  label: string;
  enabled: boolean;
}

interface AppSettings {
  scanRoots: ScanRoot[];
  archiveRoot: string;
  watchIntervalMinutes: number;
  aiEnabled: boolean;
  autoRefresh: boolean;
}

interface MoleRun {
  id: string;
  command: string;
  args: string[];
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'failed';
  output: string[];
  riskLevel: 'Safe' | 'Medium' | 'Destructive';
}

interface FileOperation {
  id: string;
  type: 'delete' | 'move' | 'archive' | 'rename';
  sourcePath: string;
  targetPath?: string;
  timestamp: string;
  status: 'pending' | 'completed' | 'failed';
}

interface AppState {
  // Settings
  settings: AppSettings;
  updateSettings: (settings: Partial<AppSettings>) => void;

  // Mole runs
  moleRuns: MoleRun[];
  addMoleRun: (run: MoleRun) => void;
  updateMoleRun: (id: string, updates: Partial<MoleRun>) => void;
  clearOldRuns: (keepCount: number) => void;

  // File operations
  fileOps: FileOperation[];
  addFileOp: (op: FileOperation) => void;
  updateFileOp: (id: string, updates: Partial<FileOperation>) => void;

  // UI state
  selectedRoot: string;
  setSelectedRoot: (path: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Default settings
      settings: {
        scanRoots: [
          { path: '~/Projects', label: 'Projects', enabled: true },
          { path: '~/Documents/ClientWork', label: 'Client Work', enabled: true },
        ],
        archiveRoot: '~/Archives/MoleBoard',
        watchIntervalMinutes: 5,
        aiEnabled: true,
        autoRefresh: true,
      },
      updateSettings: (newSettings) =>
        set((state) => ({
          settings: { ...state.settings, ...newSettings },
        })),

      // Mole runs
      moleRuns: [],
      addMoleRun: (run) =>
        set((state) => ({
          moleRuns: [run, ...state.moleRuns].slice(0, 100), // Keep last 100
        })),
      updateMoleRun: (id, updates) =>
        set((state) => ({
          moleRuns: state.moleRuns.map((run) =>
            run.id === id ? { ...run, ...updates } : run
          ),
        })),
      clearOldRuns: (keepCount) =>
        set((state) => ({
          moleRuns: state.moleRuns.slice(0, keepCount),
        })),

      // File operations
      fileOps: [],
      addFileOp: (op) =>
        set((state) => ({
          fileOps: [op, ...state.fileOps].slice(0, 50),
        })),
      updateFileOp: (id, updates) =>
        set((state) => ({
          fileOps: state.fileOps.map((op) =>
            op.id === id ? { ...op, ...updates } : op
          ),
        })),

      // UI state
      selectedRoot: '',
      setSelectedRoot: (path) => set({ selectedRoot: path }),
      sidebarOpen: true,
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
    }),
    {
      name: 'moleboard-store',
      partialize: (state) => ({
        settings: state.settings,
        selectedRoot: state.selectedRoot,
        sidebarOpen: state.sidebarOpen,
      }),
    }
  )
);
