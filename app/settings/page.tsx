"use client";

import { useState } from "react";
import { MainLayout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Settings,
  FolderOpen,
  Archive,
  Clock,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Save,
  RefreshCw,
  Trash2,
  Download,
} from "lucide-react";

export default function SettingsPage() {
  const [scanRoots, setScanRoots] = useState([
    { path: "~/Projects", label: "Projects", enabled: true },
    { path: "~/Documents/ClientWork", label: "Client Work", enabled: true },
  ]);
  const [archiveRoot, setArchiveRoot] = useState("~/Archives/MoleBoard");
  const [watchInterval, setWatchInterval] = useState(5);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [saving, setSaving] = useState(false);

  const addScanRoot = () => {
    setScanRoots([...scanRoots, { path: "", label: "", enabled: true }]);
  };

  const updateScanRoot = (index: number, field: string, value: string | boolean) => {
    const updated = [...scanRoots];
    updated[index] = { ...updated[index], [field]: value };
    setScanRoots(updated);
  };

  const removeScanRoot = (index: number) => {
    setScanRoots(scanRoots.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    setSaving(true);
    // Simulate save
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setSaving(false);
    alert("Settings saved!");
  };

  const clearCache = async () => {
    if (confirm("Are you sure you want to clear all cached scan data?")) {
      await fetch("/api/scan?clearCache=true", { method: "DELETE" });
      alert("Cache cleared!");
    }
  };

  const exportData = () => {
    const data = {
      scanRoots,
      archiveRoot,
      watchInterval,
      aiEnabled,
      autoRefresh,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "moleboard-settings.json";
    a.click();
  };

  return (
    <MainLayout>
      <div className="space-y-6 max-w-4xl">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Settings</h1>
          <p className="text-muted-foreground">
            Configure MoleBoard preferences and behavior
          </p>
        </div>

        {/* Scan Roots */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderOpen className="w-5 h-5" />
              Scan Roots
            </CardTitle>
            <CardDescription>
              Directories to scan for large files and organize
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {scanRoots.map((root, index) => (
              <div key={index} className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={root.enabled}
                    onChange={(e) => updateScanRoot(index, "enabled", e.target.checked)}
                    className="rounded"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4 flex-1">
                  <div>
                    <Label>Path</Label>
                    <Input
                      value={root.path}
                      onChange={(e) => updateScanRoot(index, "path", e.target.value)}
                      placeholder="~/Projects"
                    />
                  </div>
                  <div>
                    <Label>Label</Label>
                    <Input
                      value={root.label}
                      onChange={(e) => updateScanRoot(index, "label", e.target.value)}
                      placeholder="Projects"
                    />
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeScanRoot(index)}
                  className="text-destructive"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" onClick={addScanRoot}>
              Add Scan Root
            </Button>
          </CardContent>
        </Card>

        {/* Archive Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Archive className="w-5 h-5" />
              Archive Settings
            </CardTitle>
            <CardDescription>
              Where archived files are stored
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div>
              <Label>Archive Root</Label>
              <Input
                value={archiveRoot}
                onChange={(e) => setArchiveRoot(e.target.value)}
                placeholder="~/Archives/MoleBoard"
              />
              <p className="text-sm text-muted-foreground mt-1">
                Files will be archived to: {archiveRoot}/YYYY-MM-DD/
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Watch & Scan Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5" />
              Watch & Scan Settings
            </CardTitle>
            <CardDescription>
              How often to watch for changes and rescan
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <Label>Watch Interval (minutes)</Label>
                <Input
                  type="number"
                  value={watchInterval}
                  onChange={(e) => setWatchInterval(parseInt(e.target.value))}
                  min={1}
                  max={60}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Auto Refresh Dashboard</Label>
                  <p className="text-sm text-muted-foreground">
                    Automatically refresh data on the dashboard
                  </p>
                </div>
                <button
                  onClick={() => setAutoRefresh(!autoRefresh)}
                  className="text-2xl"
                >
                  {autoRefresh ? (
                    <ToggleRight className="w-10 h-10 text-green-600" />
                  ) : (
                    <ToggleLeft className="w-10 h-10 text-gray-400" />
                  )}
                </button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* AI Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5" />
              AI & Content ID
            </CardTitle>
            <CardDescription>
              Enable AI-powered content analysis and tagging
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <Label>Enable AI Analysis</Label>
                <p className="text-sm text-muted-foreground">
                  Use AI to generate content summaries, tags, and search embeddings
                </p>
              </div>
              <button
                onClick={() => setAiEnabled(!aiEnabled)}
                className="text-2xl"
              >
                {aiEnabled ? (
                  <ToggleRight className="w-10 h-10 text-green-600" />
                ) : (
                  <ToggleLeft className="w-10 h-10 text-gray-400" />
                )}
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Data Management */}
        <Card>
          <CardHeader>
            <CardTitle>Data Management</CardTitle>
            <CardDescription>
              Manage cached data and exports
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4">
            <Button variant="outline" onClick={clearCache}>
              <Trash2 className="w-4 h-4 mr-2" />
              Clear Cache
            </Button>
            <Button variant="outline" onClick={exportData}>
              <Download className="w-4 h-4 mr-2" />
              Export Settings
            </Button>
          </CardContent>
        </Card>

        {/* Save Button */}
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save Settings
              </>
            )}
          </Button>
        </div>
      </div>
    </MainLayout>
  );
}
