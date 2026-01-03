"use client";

import { useState, useEffect } from "react";
import { MainLayout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatBytes, sanitizeFilename } from "@/lib/utils";
import {
  Archive,
  FolderOpen,
  FileType,
  ArrowRight,
  RefreshCw,
  Loader2,
  Check,
  X,
  Sparkles,
  Wand2,
  FolderInput,
} from "lucide-react";

interface FileInfo {
  path: string;
  name: string;
  size: number;
  ext: string;
  modifiedAt: string;
  assetType: string;
  brand: string;
  project: string;
  collection: string;
  tags: string[];
  suggestedName: string;
  suggestedPath: string;
}

interface OrganizePlan {
  files: FileInfo[];
  newFolderStructure: {
    path: string;
    files: string[];
  }[];
  renames: {
    oldPath: string;
    newPath: string;
    reason: string;
  }[];
}

export default function OrganizePage() {
  const [selectedFolder, setSelectedFolder] = useState("~/Projects");
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [applying, setApplying] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  // Sample files for demo (in real app, these come from scanner + content-id)
  const sampleFiles: FileInfo[] = [
    {
      path: "/Users/bryan/Clients/Critters/assets/anim/fight_01.gif",
      name: "fight_01.gif",
      size: 12_345_678,
      ext: ".gif",
      modifiedAt: new Date().toISOString(),
      assetType: "gif",
      brand: "critters",
      project: "critters_quest",
      collection: "characters",
      tags: ["fighting", "pig", "tiger", "animation"],
      suggestedName: "critters_fighting_pig_vs_tiger_anim_v01.gif",
      suggestedPath: "/Users/bryan/Clients/Critters/assets/gifs/fighting/critters_fighting_pig_vs_tiger_anim_v01.gif",
    },
    {
      path: "/Users/bryan/Clients/Critters/assets/logos/rosita_main.png",
      name: "rosita_main.png",
      size: 2_345_678,
      ext: ".png",
      modifiedAt: new Date().toISOString(),
      assetType: "image",
      brand: "critters",
      project: "critters_quest",
      collection: "logo",
      tags: ["logo", "rosita", "branding"],
      suggestedName: "critters_rosita_logo_v01.png",
      suggestedPath: "/Users/bryan/Clients/Critters/assets/logos/critters_rosita_logo_v01.png",
    },
    {
      path: "/Users/bryan/Projects/CodeAndPalette/website/mockups/home_v3.psd",
      name: "home_v3.psd",
      size: 45_678_901,
      ext: ".psd",
      modifiedAt: new Date().toISOString(),
      assetType: "design",
      brand: "code_and_palette",
      project: "website",
      collection: "mockups",
      tags: ["homepage", "mockup", "design"],
      suggestedName: "code_and_palette_homepage_mockup_v03.psd",
      suggestedPath: "/Users/bryan/Projects/CodeAndPalette/design/mockups/code_and_palette_homepage_mockup_v03.psd",
    },
  ];

  const generatePlan = async () => {
    setLoading(true);
    // Simulate AI analysis
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Group files by brand/project
    const byBrand: Record<string, FileInfo[]> = {};
    for (const file of sampleFiles) {
      const key = `${file.brand}/${file.project}`;
      if (!byBrand[key]) byBrand[key] = [];
      byBrand[key].push(file);
    }

    // Create organize plan
    const newFolderStructure = Object.entries(byBrand).map(([key, files]) => {
      const [brand, project] = key.split("/");
      return {
        path: `/Organized/${brand}/${project}`,
        files: files.map((f) => f.path),
      };
    });

    const renames = sampleFiles.map((file) => ({
      oldPath: file.path,
      newPath: file.suggestedPath,
      reason: `Renamed to follow naming convention: ${file.brand}_${file.collection}_${file.tags[0] || "asset"}_v01${file.ext}`,
    }));

    setPlan({
      files: sampleFiles,
      newFolderStructure,
      renames,
    });
    setLoading(false);
  };

  const toggleFileSelection = (path: string) => {
    const newSet = new Set(selectedFiles);
    if (newSet.has(path)) {
      newSet.delete(path);
    } else {
      newSet.add(path);
    }
    setSelectedFiles(newSet);
  };

  const selectAll = () => {
    setSelectedFiles(new Set(sampleFiles.map((f) => f.path)));
  };

  const deselectAll = () => {
    setSelectedFiles(new Set());
  };

  const applyPlan = async () => {
    setApplying(true);
    // Simulate applying changes
    await new Promise((resolve) => setTimeout(resolve, 2000));
    setApplying(false);
    alert("Organization plan applied successfully!");
    setPlan(null);
    setSelectedFiles(new Set());
  };

  const filteredFiles = sampleFiles.filter(
    (f) =>
      f.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Organize & Rename</h1>
            <p className="text-muted-foreground">
              AI-assisted file organization and naming suggestions
            </p>
          </div>
        </div>

        {/* Folder Selection */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-4">
              <div className="relative flex-1 max-w-md">
                <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={selectedFolder}
                  onChange={(e) => setSelectedFolder(e.target.value)}
                  className="pl-9"
                  placeholder="Select folder to organize..."
                />
              </div>
              <Button onClick={generatePlan} disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 mr-2" />
                    Generate Plan
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Results */}
        {plan && (
          <div className="space-y-6">
            {/* Plan Summary */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wand2 className="w-5 h-5" />
                  Organization Plan
                </CardTitle>
                <CardDescription>
                  Review the suggested changes before applying
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4 mb-6">
                  <div className="text-center p-4 bg-muted rounded-lg">
                    <p className="text-2xl font-bold">{plan.files.length}</p>
                    <p className="text-sm text-muted-foreground">Files to organize</p>
                  </div>
                  <div className="text-center p-4 bg-muted rounded-lg">
                    <p className="text-2xl font-bold">{plan.newFolderStructure.length}</p>
                    <p className="text-sm text-muted-foreground">New folders</p>
                  </div>
                  <div className="text-center p-4 bg-muted rounded-lg">
                    <p className="text-2xl font-bold">{plan.renames.length}</p>
                    <p className="text-sm text-muted-foreground">Renames</p>
                  </div>
                </div>

                {/* File Selection */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium">Select Files to Organize</h4>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={selectAll}>
                        Select All
                      </Button>
                      <Button variant="ghost" size="sm" onClick={deselectAll}>
                        Deselect All
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2 max-h-96 overflow-auto">
                    {plan.files.map((file) => (
                      <div
                        key={file.path}
                        className={`flex items-center gap-4 p-3 rounded-lg border cursor-pointer transition-colors ${
                          selectedFiles.has(file.path)
                            ? "border-primary bg-primary/5"
                            : "hover:bg-muted"
                        }`}
                        onClick={() => toggleFileSelection(file.path)}
                      >
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(file.path)}
                          onChange={() => toggleFileSelection(file.path)}
                          className="rounded"
                        />
                        <div className="p-2 bg-muted rounded">
                          <FileType className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{file.name}</p>
                          <p className="text-sm text-muted-foreground truncate">{file.path}</p>
                        </div>
                        <ArrowRight className="w-4 h-4 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{file.suggestedName}</p>
                          <p className="text-sm text-muted-foreground truncate">
                            {file.brand} / {file.project} / {file.collection}
                          </p>
                        </div>
                        <div className="flex gap-1">
                          {file.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="secondary">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex justify-end gap-3 mt-6">
                  <Button variant="outline" onClick={() => setPlan(null)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={applyPlan}
                    disabled={selectedFiles.size === 0 || applying}
                  >
                    {applying ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Applying...
                      </>
                    ) : (
                      <>
                        <FolderInput className="w-4 h-4 mr-2" />
                        Apply to {selectedFiles.size} Files
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* New Folder Structure */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Proposed Folder Structure</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {plan.newFolderStructure.map((folder, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-3 p-2 rounded hover:bg-muted"
                    >
                      <Archive className="w-4 h-4 text-muted-foreground" />
                      <span className="font-mono text-sm">{folder.path}</span>
                      <Badge variant="secondary">{folder.files.length} files</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Rename Details */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Rename Details</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {plan.renames.map((rename, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-4 p-3 rounded-lg border"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-muted-foreground truncate">
                          {rename.oldPath}
                        </p>
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{rename.newPath.split("/").pop()}</p>
                      </div>
                      <p className="text-xs text-muted-foreground shrink-0 max-w-xs truncate">
                        {rename.reason}
                      </p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Empty State */}
        {!plan && !loading && (
          <Card>
            <CardContent className="py-12 text-center">
              <Archive className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">Generate an Organization Plan</h3>
              <p className="text-muted-foreground mt-2 max-w-md mx-auto">
                Select a folder and let AI analyze your files to suggest consistent naming
                and folder organization based on brand, project, and content type.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </MainLayout>
  );
}
