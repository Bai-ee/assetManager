"use client";

import { useState, useEffect } from "react";
import { MainLayout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatBytes, getMediaType } from "@/lib/utils";
import {
  Search,
  Filter,
  X,
  FileVideo,
  FileImage,
  FileType,
  FileAudio,
  ArchiveBox,
  Code,
  Eye,
  ExternalLink,
  Loader2,
  Grid3X3,
  List,
  Sparkles,
  RefreshCw,
} from "lucide-react";

interface SearchResult {
  file_id: string;
  path: string;
  filename: string;
  ext: string;
  size_bytes: number;
  asset_type: string;
  brand: string;
  project: string;
  collection: string;
  tags: string[];
  content_summary: string;
  modified_at: string;
  suggested_name: string;
}

const MOCK_RESULTS: SearchResult[] = [
  {
    file_id: "abc123",
    path: "/Users/bryan/Clients/Critters/assets/anim/fight_01.gif",
    filename: "fight_01.gif",
    ext: ".gif",
    size_bytes: 12_345_678,
    asset_type: "gif",
    brand: "critters",
    project: "critters_quest",
    collection: "characters",
    tags: ["fighting", "pig", "tiger", "animation", "pixel-art"],
    content_summary: "Pixel art animation of pig fighting tiger in Critters Quest game",
    modified_at: new Date().toISOString(),
    suggested_name: "critters_fighting_pig_vs_tiger_anim_v01.gif",
  },
  {
    file_id: "def456",
    path: "/Users/bryan/Projects/CodeAndPalette/website/images/rosita_logo.png",
    filename: "rosita_logo.png",
    ext: ".png",
    size_bytes: 2_345_678,
    asset_type: "image",
    brand: "code_and_palette",
    project: "website",
    collection: "logo",
    tags: ["logo", "rosita", "branding", "website"],
    content_summary: "Rositas restaurant logo for Code & Palette website",
    modified_at: new Date().toISOString(),
    suggested_name: "code_and_palette_rosita_logo_v01.png",
  },
  {
    file_id: "ghi789",
    path: "/Users/bryan/Clients/Critters/marketing/social_posts/pig_mine.gif",
    filename: "pig_mine.gif",
    ext: ".gif",
    size_bytes: 5_678_901,
    asset_type: "gif",
    brand: "critters",
    project: "critters_quest",
    collection: "social_posts",
    tags: ["pig", "mining", "social", "gif"],
    content_summary: "Social media GIF of pig mining in Critters Quest",
    modified_at: new Date().toISOString(),
    suggested_name: "critters_pig_mining_social_v01.gif",
  },
  {
    file_id: "jkl012",
    path: "/Users/bryan/Projects/CodeAndPalette/design/mockups/homepage_v3.psd",
    filename: "homepage_v3.psd",
    ext: ".psd",
    size_bytes: 45_678_901,
    asset_type: "design",
    brand: "code_and_palette",
    project: "website",
    collection: "mockups",
    tags: ["homepage", "mockup", "design", "psd"],
    content_summary: "Homepage design mockup version 3 for Code & Palette website",
    modified_at: new Date().toISOString(),
    suggested_name: "code_and_palette_homepage_mockup_v03.psd",
  },
];

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null);
  const [filters, setFilters] = useState({
    brand: "",
    asset_type: "",
    collection: "",
    tags: [] as string[],
  });

  const handleSearch = async () => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    setLoading(true);
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Filter mock results based on query
    const filtered = MOCK_RESULTS.filter(
      (r) =>
        r.filename.toLowerCase().includes(query.toLowerCase()) ||
        r.tags.some((t) => t.toLowerCase().includes(query.toLowerCase())) ||
        r.content_summary.toLowerCase().includes(query.toLowerCase()) ||
        r.brand.includes(query.toLowerCase()) ||
        r.project.includes(query.toLowerCase())
    );

    setResults(filtered);
    setLoading(false);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query) handleSearch();
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const handleReveal = async (path: string) => {
    await fetch("/api/file", {
      method: "POST",
      body: JSON.stringify({ action: "reveal", path }),
    });
  };

  const handleOpenFolder = (path: string) => {
    const folder = path.substring(0, path.lastIndexOf("/"));
    window.open(`file://${folder}`, "_blank");
  };

  const getAssetIcon = (type: string) => {
    const icons: Record<string, React.ReactNode> = {
      video: <FileVideo className="w-5 h-5" />,
      image: <FileImage className="w-5 h-5" />,
      gif: <FileImage className="w-5 h-5" />,
      design: <FileType className="w-5 h-5" />,
      audio: <FileAudio className="w-5 h-5" />,
      archive: <ArchiveBox className="w-5 h-5" />,
      code: <Code className="w-5 h-5" />,
    };
    return icons[type] || <FileType className="w-5 h-5" />;
  };

  const getAssetColor = (type: string): string => {
    const colors: Record<string, string> = {
      video: "media-video",
      image: "media-image",
      gif: "media-image",
      design: "media-design",
      audio: "media-audio",
      archive: "media-archive",
      code: "media-code",
    };
    return colors[type] || "";
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Content Search</h1>
          <p className="text-muted-foreground">
            Search your indexed content by name, tags, and description
          </p>
        </div>

        {/* Search Bar */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search for images, videos, designs... (e.g., 'critters fighting', 'rosita logo')"
                  className="pl-9 text-lg"
                />
              </div>
              <Button variant="outline" onClick={handleSearch} disabled={loading}>
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
              </Button>
            </div>

            {/* Quick Filters */}
            <div className="flex flex-wrap gap-2 mt-4">
              <span className="text-sm text-muted-foreground">Quick filters:</span>
              {["critters", "rosita", "logo", "animation", "mockup", "social"].map((tag) => (
                <Badge
                  key={tag}
                  variant="outline"
                  className="cursor-pointer hover:bg-muted"
                  onClick={() => setQuery(tag)}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Filters */}
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-4">
              <select
                value={filters.brand}
                onChange={(e) => setFilters({ ...filters, brand: e.target.value })}
                className="px-3 py-2 border rounded-lg bg-background"
              >
                <option value="">All Brands</option>
                <option value="critters">Critters</option>
                <option value="rositas">Rositas</option>
                <option value="code_and_palette">Code & Palette</option>
              </select>

              <select
                value={filters.asset_type}
                onChange={(e) => setFilters({ ...filters, asset_type: e.target.value })}
                className="px-3 py-2 border rounded-lg bg-background"
              >
                <option value="">All Types</option>
                <option value="image">Images</option>
                <option value="gif">GIFs</option>
                <option value="video">Videos</option>
                <option value="design">Design Files</option>
              </select>

              <select
                value={filters.collection}
                onChange={(e) => setFilters({ ...filters, collection: e.target.value })}
                className="px-3 py-2 border rounded-lg bg-background"
              >
                <option value="">All Collections</option>
                <option value="logo">Logo</option>
                <option value="characters">Characters</option>
                <option value="mockups">Mockups</option>
                <option value="social_posts">Social Posts</option>
              </select>

              <div className="flex border rounded-lg overflow-hidden ml-auto">
                <Button
                  variant={viewMode === "grid" ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() => setViewMode("grid")}
                >
                  <Grid3X3 className="w-4 h-4" />
                </Button>
                <Button
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() => setViewMode("list")}
                >
                  <List className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Results */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : results.length > 0 ? (
          <div className={viewMode === "grid" ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" : "space-y-4"}>
            {results.map((result) => {
              const colorClass = getAssetColor(result.asset_type);
              return (
                <Card
                  key={result.file_id}
                  className={`cursor-pointer transition-all hover:ring-2 hover:ring-primary ${
                    selectedResult?.file_id === result.file_id ? "ring-2 ring-primary" : ""
                  }`}
                  onClick={() => setSelectedResult(result)}
                >
                  <CardContent className={`p-4 ${viewMode === "list" ? "flex items-center gap-4" : ""}`}>
                    {/* Preview Icon */}
                    <div className={`p-3 rounded-lg ${colorClass} w-fit shrink-0`}>
                      {getAssetIcon(result.asset_type)}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{result.filename}</p>
                      <p className="text-sm text-muted-foreground truncate">{result.path}</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        <Badge variant="secondary">{result.brand}</Badge>
                        <Badge variant="outline">{result.collection}</Badge>
                        {result.tags.slice(0, 3).map((tag) => (
                          <Badge key={tag} variant="outline" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    {/* Size & Actions */}
                    <div className={viewMode === "list" ? "shrink-0" : "mt-3"}>
                      <span className="text-sm font-mono">{formatBytes(result.size_bytes)}</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : query ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Search className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No results found</h3>
              <p className="text-muted-foreground mt-2">
                Try different keywords or adjust your filters
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <Sparkles className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">Search your content</h3>
              <p className="text-muted-foreground mt-2">
                Enter keywords, tags, or natural language queries to find your files
              </p>
            </CardContent>
          </Card>
        )}

        {/* Result Detail Drawer */}
        {selectedResult && (
          <Card className="fixed bottom-0 left-0 right-0 m-4 shadow-lg z-50">
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-xl font-bold">{selectedResult.filename}</h3>
                    <Badge variant="secondary">{selectedResult.brand}</Badge>
                    <Badge variant="outline">{selectedResult.collection}</Badge>
                  </div>
                  <p className="text-muted-foreground mb-4">{selectedResult.path}</p>
                  <p className="mb-4">{selectedResult.content_summary}</p>
                  <div className="flex flex-wrap gap-2 mb-4">
                    {selectedResult.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Size: {formatBytes(selectedResult.size_bytes)} | Modified:{" "}
                    {new Date(selectedResult.modified_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex flex-col gap-2 ml-4">
                  <Button variant="outline" onClick={() => handleReveal(selectedResult.path)}>
                    <Eye className="w-4 h-4 mr-2" />
                    Reveal in Finder
                  </Button>
                  <Button variant="outline" onClick={() => handleOpenFolder(selectedResult.path)}>
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Open Folder
                  </Button>
                  <Button variant="ghost" onClick={() => setSelectedResult(null)}>
                    <X className="w-4 h-4 mr-2" />
                    Close
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </MainLayout>
  );
}
