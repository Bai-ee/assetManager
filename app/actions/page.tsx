"use client";

import { useState, useEffect, useRef } from "react";
import { MainLayout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { getRiskLevel, formatRelativeTime } from "@/lib/utils";
import {
  Zap,
  Trash2,
  Download,
  RefreshCw,
  Activity,
  Play,
  Eye,
  Terminal,
  Copy,
  Check,
  AlertTriangle,
  Shield,
  ChevronDown,
  ChevronUp,
  Loader2,
} from "lucide-react";

interface MoleCommand {
  command: string;
  description: string;
  riskLevel: "Safe" | "Medium" | "Destructive";
  requiresConfirm?: boolean;
}

const MOLE_COMMANDS: MoleCommand[] = [
  {
    command: "status",
    description: "Show system health and disk status",
    riskLevel: "Safe",
  },
  {
    command: "clean",
    description: "Clean up system caches and junk files",
    riskLevel: "Medium",
    requiresConfirm: true,
  },
  {
    command: "uninstall",
    description: "Remove unused applications",
    riskLevel: "Destructive",
    requiresConfirm: true,
  },
  {
    command: "optimize",
    description: "Optimize system performance",
    riskLevel: "Medium",
    requiresConfirm: true,
  },
  {
    command: "analyze",
    description: "Analyze disk usage interactively",
    riskLevel: "Safe",
  },
  {
    command: "purge",
    description: "Purge project artifacts and build files",
    riskLevel: "Destructive",
    requiresConfirm: true,
  },
];

interface MoleRun {
  id: string;
  command: string;
  args: string[];
  startTime: string;
  endTime?: string;
  status: "running" | "completed" | "failed";
  riskLevel: string;
  stdout: string;
  stderr: string;
}

export default function ActionsPage() {
  const [selectedCommand, setSelectedCommand] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [recentRuns, setRecentRuns] = useState<MoleRun[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Load recent runs
  useEffect(() => {
    async function loadRuns() {
      try {
        const res = await fetch("/api/run?limit=20");
        const data = await res.json();
        setRecentRuns(data);
      } catch (error) {
        console.error("Failed to load runs:", error);
      }
    }
    loadRuns();
  }, []);

  // SSE for streaming logs
  useEffect(() => {
    if (!currentRunId) return;

    const eventSource = new EventSource(`/api/stream/${currentRunId}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "output") {
        setLogs((prev) => [...prev, data.output]);
      } else if (data.type === "end") {
        setIsRunning(false);
        eventSource.close();
        // Reload runs
        fetch("/api/run?limit=20")
          .then((res) => res.json())
          .then(setRecentRuns);
      } else if (data.type === "error") {
        setLogs((prev) => [...prev, `Error: ${data.message}`]);
        setIsRunning(false);
        eventSource.close();
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      setIsRunning(false);
    };

    return () => eventSource.close();
  }, [currentRunId]);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleRunCommand = async (command: string, dryRun = true) => {
    setIsRunning(true);
    setLogs([]);
    setCurrentRunId(null);

    const args = dryRun ? ["--dry-run"] : [];

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, args }),
      });

      const data = await res.json();

      if (data.success) {
        setCurrentRunId(data.runId);
        setLogs([`Running: mo ${command} ${args.join(" ")}`, ""]);
      } else {
        setLogs([`Error: ${data.error}`]);
        setIsRunning(false);
      }
    } catch (error) {
      setLogs([`Error: ${error}`]);
      setIsRunning(false);
    }
  };

  const handleLaunchTerminal = (command: string) => {
    const fullCommand = `mo ${command}`;
    // Use AppleScript to open Terminal and run command
    const script = `
      tell application "Terminal"
        activate
        do script with command "cd ~ && ${fullCommand}"
      end tell
    `;
    const encodedScript = encodeURIComponent(script);
    window.location.href = `javascript:eval(decodeURIComponent('${encodedScript}'))`;
  };

  const copyCommand = (run: MoleRun) => {
    const cmd = `mo ${run.command} ${run.args.join(" ")}`;
    navigator.clipboard.writeText(cmd);
    setCopiedId(run.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const getRiskBadge = (level: string) => {
    switch (level) {
      case "Safe":
        return <Badge variant="success">Safe</Badge>;
      case "Medium":
        return <Badge variant="warning">Medium</Badge>;
      case "Destructive":
        return <Badge variant="destructive">Destructive</Badge>;
      default:
        return <Badge variant="secondary">{level}</Badge>;
    }
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Mole Actions</h1>
          <p className="text-muted-foreground">
            Run Mole commands to clean, optimize, and manage your system
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Commands Panel */}
          <div className="lg:col-span-1 space-y-4">
            <h2 className="text-xl font-semibold">Available Commands</h2>
            {MOLE_COMMANDS.map((cmd) => (
              <Card
                key={cmd.command}
                className={`cursor-pointer transition-all ${
                  selectedCommand === cmd.command ? "ring-2 ring-primary" : ""
                }`}
                onClick={() => setSelectedCommand(cmd.command)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium">mo {cmd.command}</span>
                        {getRiskBadge(cmd.riskLevel)}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">
                        {cmd.description}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Action Panel */}
          <div className="lg:col-span-2 space-y-4">
            {selectedCommand ? (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Zap className="w-5 h-5" />
                      mo {selectedCommand}
                    </CardTitle>
                    <CardDescription>
                      {MOLE_COMMANDS.find((c) => c.command === selectedCommand)?.description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Risk Warning */}
                    {MOLE_COMMANDS.find((c) => c.command === selectedCommand)?.riskLevel !==
                      "Safe" && (
                      <div className="flex items-start gap-3 p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
                        <AlertTriangle className="w-5 h-5 text-yellow-600 shrink-0 mt-0.5" />
                        <div>
                          <p className="font-medium text-yellow-800 dark:text-yellow-200">
                            {MOLE_COMMANDS.find((c) => c.command === selectedCommand)?.riskLevel ===
                            "Destructive"
                              ? "This action can permanently delete files"
                              : "This action modifies system settings"}
                          </p>
                          <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                            Preview first with dry-run to see what will happen.
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Action Buttons */}
                    <div className="flex flex-wrap gap-3">
                      <Button
                        onClick={() => handleRunCommand(selectedCommand, true)}
                        disabled={isRunning}
                        variant="outline"
                      >
                        <Eye className="w-4 h-4 mr-2" />
                        Preview (Dry Run)
                      </Button>
                      {MOLE_COMMANDS.find((c) => c.command === selectedCommand)?.riskLevel !==
                        "Safe" && (
                        <Button
                          onClick={() => handleRunCommand(selectedCommand, false)}
                          disabled={isRunning}
                          variant={
                            MOLE_COMMANDS.find((c) => c.command === selectedCommand)?.riskLevel ===
                            "Destructive"
                              ? "destructive"
                              : "default"
                          }
                        >
                          <Play className="w-4 h-4 mr-2" />
                          Run for Real
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        onClick={() => handleLaunchTerminal(selectedCommand)}
                      >
                        <Terminal className="w-4 h-4 mr-2" />
                        Open in Terminal
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {/* Logs Panel */}
                <Card className="h-96 flex flex-col">
                  <CardHeader className="shrink-0">
                    <CardTitle className="text-lg flex items-center gap-2">
                      {isRunning ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" />
                          Running...
                        </>
                      ) : (
                        <>
                          <Activity className="w-5 h-5" />
                          Output Log
                        </>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex-1 overflow-auto bg-muted/30 p-4 font-mono text-sm">
                    {logs.length === 0 ? (
                      <p className="text-muted-foreground">
                        Run a command to see output here
                      </p>
                    ) : (
                      <pre className="whitespace-pre-wrap">
                        {logs.map((log, i) => (
                          <div key={i} className="mb-1">
                            {log}
                          </div>
                        ))}
                        <div ref={logsEndRef} />
                      </pre>
                    )}
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card>
                <CardContent className="py-12 text-center">
                  <Zap className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium">Select a Command</h3>
                  <p className="text-muted-foreground">
                    Choose a Mole command from the left panel to get started
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Recent Runs */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Recent Runs</CardTitle>
              </CardHeader>
              <CardContent>
                {recentRuns.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">
                    No recent runs
                  </p>
                ) : (
                  <div className="space-y-2">
                    {recentRuns.map((run) => (
                      <div key={run.id}>
                        <div
                          className="flex items-center justify-between p-3 rounded-lg hover:bg-muted cursor-pointer"
                          onClick={() =>
                            setExpandedRun(expandedRun === run.id ? null : run.id)
                          }
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            {run.status === "running" ? (
                              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                            ) : run.status === "completed" ? (
                              <Check className="w-4 h-4 text-green-600 shrink-0" />
                            ) : (
                              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                            )}
                            <span className="font-mono truncate">
                              mo {run.command} {run.args.join(" ")}
                            </span>
                            {getRiskBadge(run.riskLevel)}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-sm text-muted-foreground">
                              {formatRelativeTime(run.startTime)}
                            </span>
                            {expandedRun === run.id ? (
                              <ChevronUp className="w-4 h-4" />
                            ) : (
                              <ChevronDown className="w-4 h-4" />
                            )}
                          </div>
                        </div>
                        {expandedRun === run.id && (
                          <div className="ml-7 p-3 bg-muted/50 rounded-lg text-sm">
                            <div className="flex items-center gap-2 mb-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  copyCommand(run);
                                }}
                              >
                                {copiedId === run.id ? (
                                  <Check className="w-4 h-4 mr-1" />
                                ) : (
                                  <Copy className="w-4 h-4 mr-1" />
                                )}
                                Copy Command
                              </Button>
                            </div>
                            <pre className="whitespace-pre-wrap text-xs max-h-48 overflow-auto">
                              {run.stdout || run.stderr || "No output"}
                            </pre>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
