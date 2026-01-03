import { NextRequest, NextResponse } from 'next/server';
import { getRunById } from '@/lib/mole/runner';

// GET /api/stream/[runId] - Server-Sent Events for streaming logs
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const run = getRunById(runId);

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial state
      const initialData = `data: ${JSON.stringify({
        type: 'start',
        run,
      })}\n\n`;
      controller.enqueue(encoder.encode(initialData));

      // Poll for updates until completed
      let completed = run.status !== 'running';
      let lastOutputLen = run.stdout.length + run.stderr.length;

      const checkInterval = setInterval(async () => {
        const currentRun = getRunById(runId);

        if (!currentRun) {
          const endData = `data: ${JSON.stringify({
            type: 'error',
            message: 'Run not found',
          })}\n\n`;
          controller.enqueue(encoder.encode(endData));
          controller.close();
          clearInterval(checkInterval);
          return;
        }

        // Check for new output
        const currentOutputLen = currentRun.stdout.length + currentRun.stderr.length;
        if (currentOutputLen > lastOutputLen) {
          const newOutput = currentRun.stdout + currentRun.stderr;
          const diff = newOutput.slice(lastOutputLen);
          lastOutputLen = currentOutputLen;

          const outputData = `data: ${JSON.stringify({
            type: 'output',
            output: diff,
            run: currentRun,
          })}\n\n`;
          controller.enqueue(encoder.encode(outputData));
        }

        // Check completion
        if (currentRun.status !== 'running' && !completed) {
          completed = true;
          const endData = `data: ${JSON.stringify({
            type: 'end',
            run: currentRun,
          })}\n\n`;
          controller.enqueue(encoder.encode(endData));
          controller.close();
          clearInterval(checkInterval);
        }
      }, 100);

      // Cleanup on close
      request.signal.addEventListener('abort', () => {
        clearInterval(checkInterval);
        controller.close();
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
