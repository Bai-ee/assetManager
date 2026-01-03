import { NextRequest, NextResponse } from 'next/server';
import { runMoleCommand, getRunById, getRecentRuns } from '@/lib/mole/runner';
import { isCommandAllowed, buildCommand, getCommandInfo } from '@/lib/mole/allowlist';

// POST /api/run - Execute a Mole command
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { command, args = [] } = body;

    // Validate command is allowed
    if (!isCommandAllowed(command)) {
      return NextResponse.json(
        { error: `Command '${command}' is not allowed` },
        { status: 403 }
      );
    }

    // Build the full command
    const { command: cmd, args: fullArgs, riskLevel } = buildCommand(command, args);

    // Run the command
    const { runId, process } = runMoleCommand(cmd, fullArgs, riskLevel);

    // Return immediately with run ID (streaming happens via SSE)
    return NextResponse.json({
      success: true,
      runId,
      command: cmd,
      args: fullArgs,
      riskLevel,
      message: riskLevel === 'Safe' 
        ? 'Command executed safely (preview mode)' 
        : `Command started (risk level: ${riskLevel})`,
    });
  } catch (error) {
    console.error('Error running command:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to run command' },
      { status: 500 }
    );
  }
}

// GET /api/run - Get run history or specific run
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('id');
  const limit = parseInt(searchParams.get('limit') || '20');

  if (runId) {
    const run = getRunById(runId);
    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }
    return NextResponse.json(run);
  }

  // Return recent runs
  const runs = getRecentRuns(limit);
  return NextResponse.json(runs);
}
