// Mole command allowlist for security
// Only these commands can be executed via the UI

export interface AllowedCommand {
  command: string;
  description: string;
  riskLevel: 'Safe' | 'Medium' | 'Destructive';
  args?: string[];
  requiresConfirm?: boolean;
}

export const MOLE_COMMANDS: AllowedCommand[] = [
  {
    command: 'status',
    description: 'Show system health and disk status',
    riskLevel: 'Safe',
  },
  {
    command: 'clean',
    description: 'Clean up system caches and junk files',
    riskLevel: 'Medium',
    requiresConfirm: true,
  },
  {
    command: 'uninstall',
    description: 'Remove unused applications',
    riskLevel: 'Destructive',
    requiresConfirm: true,
  },
  {
    command: 'optimize',
    description: 'Optimize system performance',
    riskLevel: 'Medium',
    requiresConfirm: true,
  },
  {
    command: 'analyze',
    description: 'Analyze disk usage interactively',
    riskLevel: 'Safe',
  },
  {
    command: 'purge',
    description: 'Purge project artifacts and build files',
    riskLevel: 'Destructive',
    requiresConfirm: true,
  },
  {
    command: 'touchid',
    description: 'Regenerate Touch ID configurations',
    riskLevel: 'Safe',
  },
  {
    command: 'completion',
    description: 'Generate shell completion scripts',
    riskLevel: 'Safe',
  },
  {
    command: 'update',
    description: 'Update Mole to latest version',
    riskLevel: 'Safe',
  },
  {
    command: 'remove',
    description: 'Remove Mole completely',
    riskLevel: 'Destructive',
    requiresConfirm: true,
  },
];

// Check if a command is allowed
export function isCommandAllowed(command: string): boolean {
  return MOLE_COMMANDS.some((c) => c.command === command);
}

// Get command info
export function getCommandInfo(command: string): AllowedCommand | undefined {
  return MOLE_COMMANDS.find((c) => c.command === command);
}

// Build full command with defaults
export function buildCommand(
  command: string,
  extraArgs: string[] = []
): { command: string; args: string[]; riskLevel: 'Safe' | 'Medium' | 'Destructive' } {
  const cmdInfo = getCommandInfo(command);
  if (!cmdInfo) {
    throw new Error(`Unknown command: ${command}`);
  }

  // Add --dry-run by default for preview actions unless already specified
  const hasDryRun = extraArgs.includes('--dry-run');
  const args = hasDryRun ? extraArgs : [...extraArgs];

  return {
    command: 'mo',
    args: [command, ...args],
    riskLevel: hasDryRun ? 'Safe' : cmdInfo.riskLevel,
  };
}
