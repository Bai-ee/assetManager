import { DiscogsClient } from './client.ts';
const c = new DiscogsClient();
const probes: Record<string,string>[] = [
  { catno: 'DT-117', label: 'Deep Touch' },
  { catno: 'IN 003', label: 'In The Air' },
  { catno: 'DFUN 001', label: 'Dis-Funktional' },
];
for (const p of probes) {
  const r = await c.search(p);
  console.log(`\n${JSON.stringify(p)} -> ${r.pagination?.items ?? r.results.length} results`);
  for (const x of r.results.slice(0, 3)) console.log(`  ${x.id}  ${x.title}  | ${x.catno} | ${(x.format||[]).join(', ')} | ${x.country||''} ${x.year||''}`);
}
