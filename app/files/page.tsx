"use client";

import { useState, useEffect } from "react";
import { MainLayout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatBytes, getMediaType } from "@/lib/utils";
import {
  Search,
  Filter,
  Grid3X3,
  List,
  FolderOpen,
  FileVideo,
  FileImage,
  FileType,
  FileAudio,
  ArchiveBox,
  Code,
  Eye,
  Trash2,
  Archive,
  Folder,
  ChevronRight,
  Loader2,
} from "lucide-react";

interface FileInfo {
  path: string;
  name: string;
  size: number;
  ext: string;
  modifiedAt: string;
  mediaType: string;
  isRepo: boolean;
  repoName?: string;
}

interface FolderInfo {
  path: string;
  name: string;
  size: number;
  fileCount: number;
  folderCount: number;
  containsRepo: boolean;
  mainType?: string;
}

const MEDIA_TYPE_CONFIG = {
  video: { icon: FileVideo, color: "media-video", label: "Video" },
  image: { icon: FileImage, color: "media-image", label: "Image" },
  design: { icon: FileType, color: "media-design", label: "Design" },
  audio: { icon: FileAudio, color: "media-audio", label: "Audio" },
  archive: { icon: ArchiveBox, color: "media-archive", label: "Archive" },
  code: { icon: Code, color: "media-code", label: "Code" },
  other: { icon: Folder, color: "bg-gray-100 text-gray-800", label: "Other" },
};

export default function FilesPage() {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRoot, setSelectedRoot] = useState("~/Projects");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterSize, setFilterSize] = useState<string>("all");
  const [showReposOnly, setShowReposOnly] = useState(false);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      try {
        const res = await fetch(`/api/scan?root=${encodeURIComponent(selectedRoot)}&force=true`);
        const data = await res.json();
        setFiles(data.largestFiles || []);
        setFolders(data.largestFolders || []);
      } catch (error) {
        console.error("Failed to load files:", error);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [selectedRoot]);

  const filteredFiles = files.filter((file) => {
    // Search filter
    if (searchQuery && !file.name.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }

    // Media type filter
    if (filterType !== "all") {
      const { type } = getMediaType(file.ext);
      if (type !== filterType) return false;
    }

    // Size filter
    if (filterSize !== "all") {
      const sizeThresholds: Record<string, number> = {
        "1gb": 1024 * 1024 * 1024,
        "5gb": 5 * 1024 * 1024 * 1024,
        "10gb": 10 * 1024 * 1024 * 1024,
      };
      const threshold = sizeThresholds[filterSize];
      if (file.size < threshold) return false;
    }

    // Repo filter
    if (showReposOnly && !file.isRepo) return false;

    return true;
  });

  const handleReveal = async (path: string) => {
    await fetch("/api/file", {
      method: "POST",
      body: JSON.stringify({ action: "reveal", path }),
    });
  };

  const handleArchive = async (path: string) => {
    await fetch("/api/file", {
      method: "POST",
      body: JSON.stringify({ action: "archive", path }),
    });
    // Refresh data
    const res = await fetch(`/api/scan?root=${encodeURIComponent(selectedRoot)}&force=true`);
    const data = await res.json();
    setFiles(data.largestFiles || []);
  };

  const handleDelete = async (path: string) => {
    if (!confirm('Are you sure you want to delete this file? This cannot be undone.')) return;
    if (prompt('Type "DELETE" to confirm deletion') !== "DELETE") return;

    await fetch("/api/file", {
      method: "POST",
      body: JSON.stringify({ action: "delete", path, confirmToken: "DELETE" }),
    });
    // Refresh data
    const res = await fetch(`/api/scan?root=${encodeURIComponent(selectedRoot)}&force=true`);
    const data = await res.json();
    setFiles(data.largestFiles || []);
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Files</h1>
            <p className="text-muted-foreground">
              Browse and manage files in your scanned directories
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
          </div>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-4">
              {/* Search */}
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search files..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>

              {/* Media Type Filter */}
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="px-3 py-2 border rounded-lg bg-background"
              >
                <option value="all">All Types</option>
                <option value="video">Video</option>
                <option value="image">Images</option>
                <option value="design">Design</option>
                <option value="audio">Audio</option>
                <option value="archive">Archives</option>
                <option value="code">Code</option>
              </select>

              {/* Size Filter */}
              <select
                value={filterSize}
                onChange={(e) => setFilterSize(e.target.value)}
                className="px-3 py-2 border rounded-lg bg-background"
              >
                <option value="all">Any Size</option>
                <option value="1gb">Bigger than 1GB</option>
                <option value="5gb">Bigger than 5GB</option>
                <option value="10gb">Bigger than 10GB</option>
              </select>

              {/* Repo Filter */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showReposOnly}
                  onChange={(e) => setShowReposOnly(e.target.checked)}
                  className="rounded"
                />
                <span className="text-sm">In Repos Only</span>
              </label>

              {/* View Mode Toggle */}
              <div className="flex border rounded-lg overflow-hidden">
                <Button
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() => setViewMode("list")}
                >
                  <List className="w-4 h-4" />
                </Button>
                <Button
                  variant={viewMode === "grid" ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() => setViewMode("grid")}
                >
                  <Grid3X3 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Results Count */}
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Showing {filteredFiles.length} of {files.length} files</span>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* File List */}
        {!loading && (
          <div className={viewMode === "grid" ? "grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4" : "space-y-2"}>
            {filteredFiles.map((file) => {
              const { type } = getMediaType(file.ext);
              const config = MEDIA_TYPE_CONFIG[type];
              const Icon = config.icon;

              return (
                <Card key={file.path} className={viewMode === "grid" ? "" : ""}>
                  <CardContent className={`p-4 ${viewMode === "list" ? "flex items-center gap-4" : ""}`}>
                    <div className={`${viewMode === "grid" ? "mb-3" : "shrink-0"}`}>
                      <div className={`p-3 rounded-lg ${config.color} w-fit`}>
                        <Icon className="w-5 h-5" />
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate" title={file.name}>
                        {file.name}
                      </p>
                      <p className="text-sm text-muted-foreground truncate" title={file.path}>
                        {file.path}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className={config.color}>
                          {config.label}
                        </Badge>
                        <span className="text-xs text-muted-foreground font-mono">
                          {formatBytes(file.size)}
                        </span>
                        {file.isRepo && (
                          <Badge variant="secondary">Repo</Badge>
                        )}
                      </div>
                    </div>
                    {viewMode === "list" && (
                      <div className="flex items-center gap-2 shrink-0">
                        <Button variant="ghost" size="icon" onClick={() => handleReveal(file.path)} title="Reveal in Finder">
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleArchive(file.path)} title="Archive">
                          <Archive className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(file.path)} title="Delete" className="text-destructive hover:text-destructive">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                    {viewMode === "grid" && (
                      <div className="flex items-center gap-1 mt-3">
                        <Button variant="ghost" size="sm" onClick={() => handleReveal(file.path)}>
                          <Eye className="w-3 h-3 mr-1" />
                          Reveal
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleArchive(file.path)}>
                          <Archive className="w-3 h-3 mr-1" />
                          Archive
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Empty State */}
        {!loading && filteredFiles.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <FolderOpen className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No files found</h3>
              <p className="text-muted-foreground">
                Try adjusting your filters or scan a different directory
              </p>
            </CardContent>
          </Card>
        )}

        {/* Folders Section */}
        <div className="mt-8">
          <h2 className="text-2xl font-bold mb-4">Largest Folders</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {folders.slice(0, 12).map((folder) => {
              const typeConfig = folder.mainType
                ? MEDIA_TYPE_CONFIG[folder.mainType as keyof typeof MEDIA_TYPE_CONFIG]
                : MEDIA_TYPE_CONFIG.other;
              const Icon = typeConfig.icon;

              return (
                <Card key={folder.path}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg ${typeConfig.color} shrink-0`}>
                        <Icon className="w-5 h-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate" title={folder.name}>
                          {folder.name}
                        </p>
                        <p className="text-sm text-muted-foreground truncate" title={folder.path}>
                          {folder.path}
                        </p>
                        <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                          <span>{folder.fileCount} files</span>
                          <span>•</span>
                          <span>{folder.folderCount} folders</span>
                          {folder.containsRepo && (
                            <>
                              <span>•</span>
                              <span className="text-blue-600">Has repo</span>
                            </>
                          )}
                        </div>
                        <div className="mt-2">
                          <Badge variant="outline" className={typeConfig.color}>
                            {typeConfig.label}
                          </Badge>
                          <span className="ml-2 text-sm font-mono">{formatBytes(folder.size)}</span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
