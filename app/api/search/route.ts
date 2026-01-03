import { NextRequest, NextResponse } from 'next/server';
import { indexDirectory, searchIndex, getIndexedBrands, getIndexedTags } from '@/lib/content-id/indexer';

// POST /api/search - Index files in a directory
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, rootPath, query, filters } = body;

    if (action === 'index') {
      if (!rootPath) {
        return NextResponse.json({ error: 'rootPath required' }, { status: 400 });
      }

      const results = await indexDirectory(rootPath, {
        progressCallback: (current, total) => {
          console.log(`Indexed ${current}/${total}`);
        },
      });

      return NextResponse.json({
        success: true,
        indexed: results.length,
      });
    }

    if (action === 'search') {
      const results = searchIndex(query || '', filters || {});
      return NextResponse.json({
        results,
        total: results.length,
      });
    }

    if (action === 'facets') {
      const brands = getIndexedBrands();
      const tags = getIndexedTags();
      return NextResponse.json({
        brands,
        tags,
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Operation failed' },
      { status: 500 }
    );
  }
}

// GET /api/search - Get search facets or specific result
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || '';
  const brand = searchParams.get('brand');
  const assetType = searchParams.get('asset_type');
  const collection = searchParams.get('collection');
  const tags = searchParams.get('tags')?.split(',').filter(Boolean);
  const minSize = searchParams.get('min_size');
  const maxSize = searchParams.get('max_size');

  try {
    const filters: Parameters<typeof searchIndex>[1] = {};

    if (brand) filters.brand = [brand];
    if (assetType) filters.asset_type = [assetType];
    if (collection) filters.collection = [collection];
    if (tags?.length) filters.tags = tags;
    if (minSize) filters.min_size = parseInt(minSize);
    if (maxSize) filters.max_size = parseInt(maxSize);

    const results = searchIndex(query, filters);

    return NextResponse.json({
      results,
      total: results.length,
      query,
      filters,
    });
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Search failed' },
      { status: 500 }
    );
  }
}
