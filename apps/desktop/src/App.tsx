import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Download,
  ExternalLink,
  FileCheck2,
  Filter,
  FolderOpen,
  Gauge,
  Globe2,
  HardDrive,
  KeyRound,
  Library,
  Network,
  Pause,
  Play,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  XCircle
} from "lucide-react";
import "./styles.css";

type View = "discover" | "downloads" | "library" | "publish" | "mesh" | "settings";
type DownloadState = "Ready" | "Downloading" | "Paused" | "Verifying" | "Verified" | "Seeding" | "Failed";

interface Release {
  id: string;
  name: string;
  publisher: string;
  fingerprint: string;
  architecture: string;
  formats: string[];
  quantisation: string;
  sizeBytes: number;
  parameters: string;
  summary: string;
  security: string;
  peers: number;
  seeds: number;
  artifacts: Array<{ path: string; sizeBytes: number; sha256: string; role: string }>;
}

interface DownloadJob {
  releaseId: string;
  state: DownloadState;
  progress: number;
  downloadedBytes: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  ratio: number;
  error?: string;
  seeding: boolean;
}

const releases: Release[] = [
  {
    id: "sha256:5c168424ec0a8bc215586d836bee22ef9ef360f684fb6ffdbcc6eb3881fc521a",
    name: "Qwen3.5 0.8B OptiQ",
    publisher: "mlx-community",
    fingerprint: "ed25519:YZlpWaWsaWoU0HNulUBO2f62HMfl-8kV",
    architecture: "qwen",
    formats: ["safetensors", "json", "jinja"],
    quantisation: "4-bit",
    sizeBytes: 684_908_584,
    parameters: "0.8B",
    summary: "Compact MLX-ready model package with tokenizer files, config, metadata, and signed torrent transport.",
    security: "Data-only release, no executable artifacts",
    peers: 7,
    seeds: 3,
    artifacts: [
      { path: "model.safetensors", sizeBytes: 649_855_112, sha256: "80d5…bb41", role: "weights" },
      { path: "mtp.safetensors", sizeBytes: 14_401_024, sha256: "a1c2…099d", role: "weights" },
      { path: "tokenizer.json", sizeBytes: 11_012_184, sha256: "713c…7aa4", role: "tokenizer" },
      { path: "config.json", sizeBytes: 1_848, sha256: "f317…945d", role: "config" }
    ]
  },
  {
    id: "sha256:8a67871261755222d6696c33da8fd9aaff5d848aec794a4ec9ba6248f234c4e4",
    name: "Tiny Local GGUF",
    publisher: "Shardseed Fixtures",
    fingerprint: "ed25519:fixture-publisher",
    architecture: "llama",
    formats: ["gguf", "md"],
    quantisation: "Q4_K_M",
    sizeBytes: 524_319,
    parameters: "synthetic",
    summary: "Small signed fixture release used for torrent, verification, and mesh tests.",
    security: "Data-only release, no executable artifacts",
    peers: 2,
    seeds: 2,
    artifacts: [
      { path: "tiny-model-Q4_K_M.gguf", sizeBytes: 524_288, sha256: "5c3a…91aa", role: "weights" },
      { path: "README.md", sizeBytes: 31, sha256: "0a53…829d", role: "documentation" }
    ]
  },
  {
    id: "sha256:41b11c8540419f118d5c476258b2f2c7e281ff9e",
    name: "Qwen3 Coder 30B MLX",
    publisher: "lmstudio-community",
    fingerprint: "ed25519:catalogue-preview",
    architecture: "qwen",
    formats: ["safetensors", "json"],
    quantisation: "4-bit",
    sizeBytes: 17_587_000_000,
    parameters: "30B-A3B",
    summary: "Large multi-shard coding model package suitable for high-bandwidth swarms.",
    security: "Data-only release, no executable artifacts",
    peers: 18,
    seeds: 6,
    artifacts: [
      { path: "model-00001-of-00004.safetensors", sizeBytes: 4_294_967_296, sha256: "a807…c332", role: "weights" },
      { path: "model-00002-of-00004.safetensors", sizeBytes: 4_294_967_296, sha256: "e1a1…90df", role: "weights" },
      { path: "tokenizer.json", sizeBytes: 7_529_440, sha256: "bc14…fa02", role: "tokenizer" }
    ]
  }
];

function App() {
  const [view, setView] = useState<View>("discover");
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState("all");
  const [selectedId, setSelectedId] = useState(releases[0].id);
  const [jobs, setJobs] = useState<Record<string, DownloadJob>>({});
  const [meshNodes, setMeshNodes] = useState(3);
  const [meshRunning, setMeshRunning] = useState(false);
  const [meshComplete, setMeshComplete] = useState(false);
  const [settings, setSettings] = useState({ dht: true, seeding: true, downloadLimit: 0, uploadLimit: 0 });
  const selected = releases.find((release) => release.id === selectedId) ?? releases[0];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return releases.filter((release) => {
      const matchesQuery = !q || [release.name, release.publisher, release.architecture, release.quantisation, ...release.formats].join(" ").toLowerCase().includes(q);
      const matchesFormat = format === "all" || release.formats.includes(format);
      return matchesQuery && matchesFormat;
    });
  }, [query, format]);

  const startDownload = (release: Release) => {
    setSelectedId(release.id);
    setJobs((existing) => ({
      ...existing,
      [release.id]: {
        releaseId: release.id,
        state: "Downloading",
        progress: Math.max(existing[release.id]?.progress ?? 0, release.id === releases[0].id ? 82 : 34),
        downloadedBytes: Math.round(release.sizeBytes * (release.id === releases[0].id ? 0.82 : 0.34)),
        downloadSpeed: 18_400_000,
        uploadSpeed: 2_100_000,
        peers: Math.max(release.peers, 1),
        ratio: existing[release.id]?.ratio ?? 0.18,
        seeding: settings.seeding
      }
    }));
    setView("downloads");
  };

  const updateJob = (id: string, patch: Partial<DownloadJob>) => {
    setJobs((existing) => ({ ...existing, [id]: { ...existing[id], ...patch } }));
  };

  const verifyJob = (release: Release) => {
    updateJob(release.id, { state: "Verifying", progress: 98, downloadedBytes: release.sizeBytes });
    window.setTimeout(() => updateJob(release.id, { state: settings.seeding ? "Seeding" : "Verified", progress: 100, ratio: 1.0 }), 450);
  };

  const runMesh = () => {
    setMeshRunning(true);
    setMeshComplete(false);
    window.setTimeout(() => {
      setMeshRunning(false);
      setMeshComplete(true);
    }, 700);
  };

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Shardseed navigation">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <h1>Shardseed</h1>
            <p>Verified model swarms</p>
          </div>
        </div>
        <nav>
          <NavButton icon={<Search />} label="Discover" active={view === "discover"} onClick={() => setView("discover")} />
          <NavButton icon={<Download />} label="Downloads" active={view === "downloads"} onClick={() => setView("downloads")} />
          <NavButton icon={<Library />} label="Library" active={view === "library"} onClick={() => setView("library")} />
          <NavButton icon={<Upload />} label="Publish" active={view === "publish"} onClick={() => setView("publish")} />
          <NavButton icon={<Network />} label="Mesh" active={view === "mesh"} onClick={() => setView("mesh")} />
          <NavButton icon={<Settings />} label="Settings" active={view === "settings"} onClick={() => setView("settings")} />
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={16} />
          <span>Downloads are verified by signature and SHA-256 before entering your library.</span>
        </div>
      </aside>

      <section className="workspace">
        {view === "discover" && (
          <Discover
            query={query}
            setQuery={setQuery}
            format={format}
            setFormat={setFormat}
            releases={filtered}
            selected={selected}
            setSelectedId={setSelectedId}
            startDownload={startDownload}
            jobs={jobs}
          />
        )}
        {view === "downloads" && <DownloadsView releases={releases} jobs={jobs} updateJob={updateJob} verifyJob={verifyJob} />}
        {view === "library" && <LibraryView releases={releases} jobs={jobs} updateJob={updateJob} />}
        {view === "publish" && <PublishView />}
        {view === "mesh" && <MeshView nodes={meshNodes} setNodes={setMeshNodes} running={meshRunning} complete={meshComplete} runMesh={runMesh} />}
        {view === "settings" && <SettingsView settings={settings} setSettings={setSettings} />}
      </section>
    </main>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={active ? "nav-button active" : "nav-button"} onClick={onClick} type="button">
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Discover(props: {
  query: string;
  setQuery: (value: string) => void;
  format: string;
  setFormat: (value: string) => void;
  releases: Release[];
  selected: Release;
  setSelectedId: (id: string) => void;
  startDownload: (release: Release) => void;
  jobs: Record<string, DownloadJob>;
}) {
  return (
    <div className="discover-layout">
      <header className="topbar">
        <div>
          <h2>Discover Models</h2>
          <p>Browse signed releases, inspect artifacts, and join healthy swarms.</p>
        </div>
        <div className="searchbar">
          <Search size={18} />
          <input value={props.query} onChange={(e) => props.setQuery(e.target.value)} placeholder="Search models, publishers, formats" />
        </div>
      </header>

      <div className="filters">
        <Filter size={17} />
        <select value={props.format} onChange={(e) => props.setFormat(e.target.value)} aria-label="Format filter">
          <option value="all">All formats</option>
          <option value="gguf">GGUF</option>
          <option value="safetensors">Safetensors</option>
          <option value="json">JSON metadata</option>
        </select>
      </div>

      <div className="split">
        <div className="release-list">
          {props.releases.map((release) => (
            <button
              key={release.id}
              className={release.id === props.selected.id ? "release-row selected" : "release-row"}
              onClick={() => props.setSelectedId(release.id)}
              type="button"
            >
              <div>
                <strong>{release.name}</strong>
                <span>{release.publisher} · {release.parameters} · {formatBytes(release.sizeBytes)}</span>
              </div>
              <div className="swarm-stats"><Share2 size={15} /> {release.seeds}/{release.peers}</div>
            </button>
          ))}
        </div>
        <ReleaseDetail release={props.selected} job={props.jobs[props.selected.id]} startDownload={props.startDownload} />
      </div>
    </div>
  );
}

function ReleaseDetail({ release, job, startDownload }: { release: Release; job?: DownloadJob; startDownload: (release: Release) => void }) {
  const verified = job?.state === "Verified" || job?.state === "Seeding";
  return (
    <article className="detail-panel">
      <div className="detail-head">
        <div>
          <h2>{release.name}</h2>
          <p>{release.summary}</p>
        </div>
        <button className="primary" onClick={() => startDownload(release)} type="button">
          <Download size={18} />
          {job ? "View Transfer" : "Download"}
        </button>
      </div>
      <div className="metadata-strip">
        <Metric icon={<Gauge />} label="Size" value={formatBytes(release.sizeBytes)} />
        <Metric icon={<Globe2 />} label="Swarm" value={`${release.seeds} seeds`} />
        <Metric icon={<FileCheck2 />} label="Format" value={release.formats.join(", ")} />
        <Metric icon={<ShieldCheck />} label="Status" value={verified ? "Verified" : "Signed"} />
      </div>
      <dl className="details-grid">
        <dt>Release ID</dt><dd>{release.id}</dd>
        <dt>Publisher</dt><dd>{release.publisher}</dd>
        <dt>Publisher key</dt><dd>{release.fingerprint}</dd>
        <dt>Architecture</dt><dd>{release.architecture}</dd>
        <dt>Quantisation</dt><dd>{release.quantisation}</dd>
        <dt>Security</dt><dd>{release.security}</dd>
      </dl>
      <ArtifactTable artifacts={release.artifacts} />
    </article>
  );
}

function DownloadsView({ releases, jobs, updateJob, verifyJob }: { releases: Release[]; jobs: Record<string, DownloadJob>; updateJob: (id: string, patch: Partial<DownloadJob>) => void; verifyJob: (release: Release) => void }) {
  const active = Object.values(jobs);
  if (!active.length) {
    return <EmptyState icon={<Download />} title="No Active Transfers" body="Start a download from Discover to track progress, peers, verification, and seeding." />;
  }
  return (
    <section className="stack">
      <SectionTitle icon={<Activity />} title="Downloads" subtitle="Torrent progress and post-download verification." />
      {active.map((job) => {
        const release = releases.find((item) => item.id === job.releaseId)!;
        return (
          <article className="transfer" key={job.releaseId}>
            <div className="transfer-main">
              <div>
                <h3>{release.name}</h3>
                <p>{job.state} · {formatBytes(job.downloadedBytes)} / {formatBytes(release.sizeBytes)} · {job.peers} peers</p>
              </div>
              <StateBadge state={job.state} />
            </div>
            <progress value={job.progress} max={100} />
            <div className="transfer-grid">
              <Metric icon={<Download />} label="Down" value={`${formatBytes(job.downloadSpeed)}/s`} />
              <Metric icon={<Upload />} label="Up" value={`${formatBytes(job.uploadSpeed)}/s`} />
              <Metric icon={<Share2 />} label="Ratio" value={job.ratio.toFixed(2)} />
              <Metric icon={<HardDrive />} label="Files" value={`${release.artifacts.length}`} />
            </div>
            <div className="actions">
              {job.state === "Downloading" ? (
                <button onClick={() => updateJob(job.releaseId, { state: "Paused", downloadSpeed: 0 })} type="button"><CirclePause size={17} /> Pause</button>
              ) : (
                <button onClick={() => updateJob(job.releaseId, { state: "Downloading", downloadSpeed: 12_000_000 })} type="button"><CirclePlay size={17} /> Resume</button>
              )}
              <button onClick={() => verifyJob(release)} type="button"><ShieldCheck size={17} /> Verify</button>
              <button onClick={() => updateJob(job.releaseId, { state: "Failed", error: "Stopped by user" })} type="button"><XCircle size={17} /> Stop</button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function LibraryView({ releases, jobs, updateJob }: { releases: Release[]; jobs: Record<string, DownloadJob>; updateJob: (id: string, patch: Partial<DownloadJob>) => void }) {
  const verified = Object.values(jobs).filter((job) => job.state === "Verified" || job.state === "Seeding");
  if (!verified.length) {
    return <EmptyState icon={<Library />} title="Library Is Empty" body="Verified releases appear here after signature and SHA-256 checks complete." />;
  }
  return (
    <section className="stack">
      <SectionTitle icon={<Library />} title="Verified Library" subtitle="Open verified folders and control continued seeding." />
      {verified.map((job) => {
        const release = releases.find((item) => item.id === job.releaseId)!;
        return (
          <article className="library-row" key={job.releaseId}>
            <div>
              <h3>{release.name}</h3>
              <p>{formatBytes(release.sizeBytes)} · {release.artifacts.length} files · {release.fingerprint}</p>
            </div>
            <label className="switch">
              <input checked={job.state === "Seeding"} onChange={(e) => updateJob(job.releaseId, { state: e.target.checked ? "Seeding" : "Verified", seeding: e.target.checked })} type="checkbox" />
              <span>Seeding</span>
            </label>
            <button onClick={() => window.alert("Opening verified release folder")} type="button"><FolderOpen size={17} /> Open</button>
            <button onClick={() => window.alert("Manifest export queued")} type="button"><ExternalLink size={17} /> Export</button>
          </article>
        );
      })}
    </section>
  );
}

function PublishView() {
  const [files, setFiles] = useState("model.safetensors, tokenizer.json, config.json");
  const [signed, setSigned] = useState(false);
  return (
    <section className="publish-grid">
      <SectionTitle icon={<Upload />} title="Publish Release" subtitle="Hash files, create a torrent, sign the manifest, then seed." />
      <form className="publish-form">
        <label>Release name<input defaultValue="Qwen3.5 0.8B OptiQ" /></label>
        <label>Source files<textarea value={files} onChange={(e) => setFiles(e.target.value)} /></label>
        <label>Architecture<input defaultValue="qwen" /></label>
        <label>Publisher key<select defaultValue="local"><option value="local">Local Ed25519 publisher key</option></select></label>
        <div className="actions">
          <button onClick={() => setSigned(true)} type="button"><KeyRound size={17} /> Sign Release</button>
          <button onClick={() => window.alert("Torrent package created")} type="button"><Share2 size={17} /> Create Torrent</button>
        </div>
      </form>
      <div className="publish-summary">
        <h3>Publication Summary</h3>
        <p>{files.split(",").length} artifacts queued</p>
        <p>{signed ? "Manifest signed with selected publisher key" : "Waiting for signature"}</p>
        <p>Source files are never modified.</p>
      </div>
    </section>
  );
}

function MeshView({ nodes, setNodes, running, complete, runMesh }: { nodes: number; setNodes: (value: number) => void; running: boolean; complete: boolean; runMesh: () => void }) {
  return (
    <section className="stack">
      <SectionTitle icon={<Network />} title="Mesh Health" subtitle="Exercise publisher, downloader, verifier, and seeder handoff." />
      <div className="mesh-panel">
        <label>Nodes<input type="number" min={2} max={9} value={nodes} onChange={(e) => setNodes(Number(e.target.value))} /></label>
        <button className="primary" onClick={runMesh} disabled={running} type="button">
          {running ? <Pause size={18} /> : <Play size={18} />}
          {running ? "Running" : "Run Mesh Test"}
        </button>
      </div>
      <div className="node-ladder">
        {Array.from({ length: nodes }, (_, index) => (
          <div className="node-step" key={index}>
            <span>{index + 1}</span>
            <strong>{index === 0 ? "Publisher" : index === nodes - 1 ? "Downloader" : "Seeder"}</strong>
            <p>{complete || running ? "Connected" : "Ready"}</p>
          </div>
        ))}
      </div>
      {complete && <div className="success"><CheckCircle2 size={18} /> Mesh completed with verified handoff.</div>}
    </section>
  );
}

function SettingsView({ settings, setSettings }: { settings: { dht: boolean; seeding: boolean; downloadLimit: number; uploadLimit: number }; setSettings: (value: { dht: boolean; seeding: boolean; downloadLimit: number; uploadLimit: number }) => void }) {
  return (
    <section className="settings-layout">
      <SectionTitle icon={<SlidersHorizontal />} title="Settings" subtitle="Torrent privacy, bandwidth, and seeding defaults." />
      <form className="settings-form">
        <label className="switch"><input checked={settings.dht} onChange={(e) => setSettings({ ...settings, dht: e.target.checked })} type="checkbox" /><span>DHT peer discovery</span></label>
        <label className="switch"><input checked={settings.seeding} onChange={(e) => setSettings({ ...settings, seeding: e.target.checked })} type="checkbox" /><span>Seed verified releases by default</span></label>
        <label>Download limit<input type="number" value={settings.downloadLimit} onChange={(e) => setSettings({ ...settings, downloadLimit: Number(e.target.value) })} /></label>
        <label>Upload limit<input type="number" value={settings.uploadLimit} onChange={(e) => setSettings({ ...settings, uploadLimit: Number(e.target.value) })} /></label>
      </form>
      <div className="privacy-box">
        <ShieldCheck size={20} />
        <p>BitTorrent peers can see network participation. Shardseed does not claim anonymity and does not enable telemetry.</p>
      </div>
    </section>
  );
}

function ArtifactTable({ artifacts }: { artifacts: Release["artifacts"] }) {
  return (
    <table>
      <thead><tr><th>File</th><th>Role</th><th>Size</th><th>SHA-256</th></tr></thead>
      <tbody>
        {artifacts.map((artifact) => (
          <tr key={artifact.path}><td>{artifact.path}</td><td>{artifact.role}</td><td>{formatBytes(artifact.sizeBytes)}</td><td>{artifact.sha256}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="metric">{icon}<span>{label}</span><strong>{value}</strong></div>;
}

function SectionTitle({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return <header className="section-title">{icon}<div><h2>{title}</h2><p>{subtitle}</p></div></header>;
}

function StateBadge({ state }: { state: DownloadState }) {
  return <span className={`state ${state.toLowerCase()}`}>{state}</span>;
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <div className="empty">{icon}<h2>{title}</h2><p>{body}</p></div>;
}

function formatBytes(bytes: number) {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

createRoot(document.getElementById("root")!).render(<App />);
