"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { formatBytes, formatRelativeTime, getMediaType } from "@/lib/utils";
import {
  HardDrive,
  Folder,
  FileVideo,
  FileImage,
  FileType,
  FileAudio,
  ArchiveBox,
  Code,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
} from "lucide-react";
import Link from "next/link";

interface ScanSummary {
  totalSize: number;
  fileCount: number;
  folderCount: number;
  largestFiles: Array<{
    path: string;
    name: string;
    size: number;
    ext: string;
    modifiedAt: string;
    mediaType: string;
  }>;
  largestFolders: Array<{
    path: string;
    name: string;
    size: number;
    fileCount: number;
    mainType?: string;
  }>;
  mediaHeatmap: {
    video: { count: number; size: number };
    image: { count: number; size: number };
    design: { count: number; size: number };
    audio: { count: number; size: number };
    archive: { count: number; size: number };
    code: { count: number; size: number };
    other: { count: number; size: number };
  };
  scanTime: string;
}

interface KPICardProps {
  title: string;
  value: string;
  subValue?: string;
  icon: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  color?: string;
}

function KPICard({ title, value, subValue, icon, color = "text-primary" }: KPICardProps) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className={`text-3xl font-bold ${color}`}>{value}</p>
            {subValue && <p className="text-sm text-muted-foreground mt-1">{subValue}</p>}
          </div>
          <div className={`p-3 rounded-full bg-muted ${color}`}>{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function MediaHeatmapCard({ heatmap }: { heatmap: ScanSummary["mediaHeatmap"] }) {
  const items = [
    { key: "video", label: "Video", icon: <FileVideo className="w-4 h-4" />, color: "bg-red-500" },
    { key: "image", label: "Images", icon: <FileImage className="w-4 h-4" />, color: "bg-green-500" },
    { key: "design", label: "Design", icon: <FileType className="w-4 h-4" />, color: "bg-purple-500" },
    { key: "audio", label: "Audio", icon: <FileAudio className="w-4 h-4" />, color: "bg-amber-500" },
    { key: "archive", label: "Archives", icon: <ArchiveBox className="w-4 h-4" />, color: "bg-slate-500" },
    { key: "code", label: "Code", icon: <Code className="w-4 h-4" />, color: "bg-blue-500" },
  ];

  const totalSize = Object.values(heatmap).reduce((sum, item) => sum + item.size, 0);

  return (
    <Card className="col-span-full">
      <CardHeader>
        <CardTitle className="text-lg">Media Heatmap</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {items.map((item) => {
            const data = heatmap[item.key as keyof typeof heatmap];
            const percentage = totalSize > 0 ? (data.size / totalSize) * 100 : 0;
            return (
              <div key={item.key} className="text-center">
                <div className={`inline-flex p-2 rounded-full ${item.color} text-white mb-2`}>
                  {item.icon}
                </div>
                <p className="text-2xl font-bold">{data.count}</p>
                <p className="text-sm text-muted-foreground">{formatBytes(data.size)}</p>
                <Progress value={percentage} className="h-1 mt-2" />
                <p className="text-xs text-muted-foreground mt-1">{item.label}</p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function LargestFilesCard({ files }: { files: ScanSummary["largestFiles"] }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg">Largest Files</CardTitle>
        <Link href="/files">
          <Button variant="ghost" size="sm">
            View All
          </Button>
        </Link>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {files.slice(0, 10).map((file, idx) => {
            const { type } = getMediaType(file.ext);
            const typeColors: Record<string, string> = {
              video: "media-video",
              image: "media-image",
              design: "media-design",
              audio: "media-audio",
              archive: "media-archive",
              code: "media-code",
            };
            return (
              <div
                key={file.path}
                className="flex items-center justify-between py-2 border-b last:border-0"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-muted-foreground text-sm w-6">{idx + 1}</span>
                  <div className="min-w-0">
                    <p className="font-medium truncate">{file.name}</p>
                    <p className="text-sm text-muted-foreground truncate">{file.path}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className={typeColors[type] || ""}>
                    {type}
                  </Badge>
                  <span className="text-sm font-mono">{formatBytes(file.size)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function LargestFoldersCard({ folders }: { folders: ScanSummary["largestFolders"] }) {
  const typeColors: Record<string, string> = {
    video: "media-video",
    image: "media-image",
    design: "media-design",
    audio: "media-audio",
    archive: "media-archive",
    code: "media-code",
    mixed: "bg-gray-100 text-gray-800",
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg">Largest Folders</CardTitle>
        <Link href="/files">
          <Button variant="ghost" size="sm">
            View All
          </Button>
        </Link>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {folders.slice(0, 10).map((folder, idx) => (
            <div
              key={folder.path}
              className="flex items-center justify-between py-2 border-b last:border-0"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-muted-foreground text-sm w-6">{idx + 1}</span>
                <div className="min-w-0">
                  <p className="font-medium truncate">{folder.name}</p>
                  <p className="text-sm text-muted-foreground truncate">{folder.path}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {folder.mainType && (
                  <Badge variant="outline" className={typeColors[folder.mainType] || ""}>
                    {folder.mainType}
                  </Badge>
                )}
                <span className="text-sm font-mono">{formatBytes(folder.size)}</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SystemStatusCard() {
  const [status, setStatus] = useState<{
    used: number;
    total: number;
    apps: number;
    health: "good" | "warning" | "critical";
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const res = await fetch("/api/run?command=status");
        const data = await res.json();
        setStatus({
          used: data.disk_used || 0,
          total: data.disk_total || 0,
          apps: data.unused_apps || 0,
          health: data.health || "good",
        });
      } catch {
        // Fallback mock data
        setStatus({
          used: 450 * 1024 * 1024 * 1024, // 450 GB
          total: 1024 * 1024 * 1024 * 1024, // 1 TB
          apps: 12,
          health: "good",
        });
      } finally {
        setLoading(false);
      }
    }
    fetchStatus();
  }, []);

  if (loading || !status) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-muted rounded w-1/3"></div>
            <div className="h-8 bg-muted rounded w-2/3"></div>
            <div className="h-2 bg-muted rounded"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const usagePercent = (status.used / status.total) * 100;
  const healthColors = {
    good: "text-green-600",
    warning: "text-yellow-600",
    critical: "text-red-600",
  };
  const healthIcons = {
    good: <CheckCircle className="w-5 h-5" />,
    warning: <AlertTriangle className="w-5 h-5" />,
    critical: <AlertTriangle className="w-5 h-5" />,
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          System Status
          <span className={healthColors[status.health]}>
            {healthIcons[status.health]}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span>Disk Usage</span>
              <span className="font-mono">
                {formatBytes(status.used)} / {formatBytes(status.total)}
              </span>
            </div>
            <Progress value={usagePercent} />
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Unused Apps</span>
            <Badge variant="secondary">{status.apps} apps</Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedRoot, setSelectedRoot] = useState("~/Projects");

  useEffect(() => {
    async function loadData() {
      try {
        const res = await fetch(`/api/scan?root=${encodeURIComponent(selectedRoot)}`);
        const data = await res.json();
        setSummary(data);
      } catch (error) {
        console.error("Failed to load scan data:", error);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [selectedRoot]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Dashboard</h1>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <div className="animate-pulse">
                  <div className="h-4 bg-muted rounded w-1/2 mb-2"></div>
                  <div className="h-8 bg-muted rounded w-3/4"></div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground">
            Overview of your system and largest files
          </p>
        </div>
        <div className="flex items-center gap-4">
          <select
            value={selectedRoot}
            onChange={(e) => setSelectedRoot(e.target.value)}
            className="px-3 py-2 border rounded-lg bg-background"
          >
            <option value="~/Projects">~/Projects</option>
            <option value="~/Documents/ClientWork">~/Documents/ClientWork</option>
          </select>
          <Button variant="outline" onClick={() => window.location.reload()}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          title="Total Size"
          value={formatBytes(summary?.totalSize || 0)}
          subValue={`${summary?.fileCount || 0} files`}
          icon={<HardDrive className="w-6 h-6" />}
          color="text-blue-600"
        />
        <KPICard
          title="Largest File"
          value={summary?.largestFiles[0]?.name || "N/A"}
          subValue={formatBytes(summary?.largestFiles[0]?.size || 0)}
          icon={<FileImage className="w-6 h-6" />}
          color="text-green-600"
        />
        <KPICard
          title="Largest Folder"
          value={summary?.largestFolders[0]?.name || "N/A"}
          subValue={formatBytes(summary?.largestFolders[0]?.size || 0)}
          icon={<Folder className="w-6 h-6" />}
          color="text-purple-600"
        />
        <KPICard
          title="Last Scanned"
          value={summary ? formatRelativeTime(summary.scanTime) : "Never"}
          subValue={summary?.scanTime ? new Date(summary.scanTime).toLocaleDateString() : undefined}
          icon={<RefreshCw className="w-6 h-6" />}
          color="text-gray-600"
        />
      </div>

      {/* Media Heatmap */}
      {summary?.mediaHeatmap && <MediaHeatmapCard heatmap={summary.mediaHeatmap} />}

      {/* System Status */}
      <SystemStatusCard />

      {/* Largest Files and Folders */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {summary?.largestFiles && <LargestFilesCard files={summary.largestFiles} />}
        {summary?.largestFolders && <LargestFoldersCard folders={summary.largestFolders} />}
      </div>
    </div>
  );
}
