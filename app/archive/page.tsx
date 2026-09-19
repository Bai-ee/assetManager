export default function ArchiveWipPage() {
  const phases = [
    ["01", "NAS Foundation", "IN PROGRESS"],
    ["02", "Cloud Control Plane", "QUEUED"],
    ["03", "Media Understanding", "QUEUED"],
    ["04", "Jev Classification", "QUEUED"],
    ["05", "Review + Structure", "QUEUED"],
    ["06", "Arweave", "QUEUED"],
  ];

  return (
    <main className="min-h-screen bg-[#080808] text-white px-6 py-8 md:px-12 md:py-12">
      <div className="mx-auto max-w-7xl">
        <header className="flex items-start justify-between border-b border-white/15 pb-8">
          <div>
            <div className="text-xs uppercase tracking-[0.22em] text-white/45">HITLOOP / Archive</div>
            <h1 className="mt-3 text-4xl font-medium tracking-tight md:text-6xl">Creative Archive</h1>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/55">
              NAS-first archival pipeline. Select a source, understand the work, approve the structure,
              then preserve it permanently on Arweave.
            </p>
          </div>
          <div className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-300">
            WIP · PHASE 1
          </div>
        </header>

        <section className="grid gap-4 py-8 md:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/[.035] p-6 md:col-span-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-white/50">ARCHIVE SOURCE</span>
              <span className="text-xs text-amber-300">CONNECTOR PENDING</span>
            </div>
            <div className="mt-8 flex items-end justify-between gap-6">
              <div>
                <h2 className="text-2xl font-medium">Bryan NAS</h2>
                <p className="mt-2 text-sm text-white/45">WD My Cloud EX2 Ultra · ~1 TB archive</p>
              </div>
              <button className="rounded-xl border border-white/15 bg-white/10 px-5 py-3 text-sm text-white/70">
                Browse folders
              </button>
            </div>
            <div className="mt-8 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full w-[8%] rounded-full bg-white/70" />
            </div>
            <div className="mt-3 flex justify-between text-xs text-white/35">
              <span>Worker foundation</span><span>8%</span>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[.035] p-6">
            <div className="text-sm text-white/50">PIPELINE</div>
            <div className="mt-6 space-y-4 text-sm">
              {["Hash + dedupe", "TwelveLabs", "Jev", "Human review", "Arweave"].map((x, i) => (
                <div key={x} className="flex items-center gap-3">
                  <span className={`h-2 w-2 rounded-full ${i === 0 ? "bg-amber-300" : "bg-white/20"}`} />
                  <span className={i === 0 ? "text-white/80" : "text-white/35"}>{x}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-white/10 py-8">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-lg font-medium">Build status</h2>
            <span className="text-xs text-white/35">Resumable agent handoff enabled</span>
          </div>
          <div className="grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-3">
            {phases.map(([n, title, status]) => (
              <div key={n} className="bg-[#0d0d0d] p-5">
                <div className="text-xs text-white/30">{n}</div>
                <div className="mt-8 text-sm">{title}</div>
                <div className={`mt-2 text-[11px] tracking-wider ${status === "IN PROGRESS" ? "text-amber-300" : "text-white/25"}`}>
                  {status}
                </div>
              </div>
            ))}
          </div>
        </section>

        <footer className="border-t border-white/10 pt-6 text-xs text-white/30">
          Source files remain read-only. Permanent upload requires review and an Arweave cost quote.
        </footer>
      </div>
    </main>
  );
}
