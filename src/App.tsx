import { useCallback, useEffect, useState } from 'react';
import type { UserProfile } from './shared/types';
import { api, type DemoCatalogItem, type HydratedProject } from './lib/api';
import { buildFallbackDemoProject, FALLBACK_DEMOS } from './lib/fallbackData';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LandingPage } from './components/LandingPage';
import { Dashboard } from './components/Dashboard';
import { Workspace } from './components/Workspace';

type ViewMode = 'landing' | 'dashboard' | 'workspace';

export default function App() {
  const [view, setView] = useState<ViewMode>('landing');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [demos, setDemos] = useState<DemoCatalogItem[]>(FALLBACK_DEMOS);
  const [projects, setProjects] = useState<HydratedProject[]>([]);
  const [activeProject, setActiveProject] = useState<HydratedProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    const res = await api.listProjects();
    setProjects(Array.isArray(res?.projects) ? res.projects : []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const [meRes, demosRes, projRes] = await Promise.all([
          api.me().catch(() => ({ user: null })),
          api.listDemos().catch(() => ({ demos: FALLBACK_DEMOS })),
          api.listProjects().catch(() => ({ projects: [] as HydratedProject[] })),
        ]);
        if (cancelled) return;
        setUser(meRes?.user ?? null);
        const nextDemos =
          Array.isArray(demosRes?.demos) && demosRes.demos.length > 0
            ? demosRes.demos
            : FALLBACK_DEMOS;
        setDemos(nextDemos);
        setProjects(Array.isArray(projRes?.projects) ? projRes.projects : []);

        // Support ?autostart=1 to jump directly to dashboard or first demo
        const params = new URLSearchParams(window.location.search);
        if (params.get('autostart') === '1') {
          setView('dashboard');
        }
      } catch (err) {
        if (!cancelled) {
          setBootError(err instanceof Error ? err.message : 'Failed to connect to EDITMIND server.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTryDemo = async (demoId?: string) => {
    const targetId = demoId || demos[0]?.id || 'demo-keynote';
    try {
      const res = await api.createProjectFromDemo(targetId);
      setActiveProject(res.project);
      setView('workspace');
      await refreshProjects().catch(() => {});
    } catch {
      const localProj = buildFallbackDemoProject(targetId);
      setActiveProject(localProj);
      setProjects((prev) => [localProj, ...prev]);
      setView('workspace');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#050711] text-slate-200 flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="text-lg font-bold tracking-tight text-white">EDITMIND AI</div>
          <div className="text-xs text-slate-400">Initializing media workspace...</div>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="min-h-screen bg-[#050711] text-slate-200 flex items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-rose-500/40 bg-rose-950/20 p-6 text-center space-y-3">
          <div className="text-base font-bold text-white">Connection Error</div>
          <p className="text-xs text-rose-200">{bootError}</p>
          <button
            type="button"
            onClick={() => {
              setBootError(null);
              setView('landing');
            }}
            className="rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 cursor-pointer mr-2"
          >
            Back Home
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-white/15 bg-slate-900 px-4 py-2 text-xs font-semibold text-white cursor-pointer"
          >
            Reload Application
          </button>
        </div>
      </div>
    );
  }

  if (view === 'workspace' && activeProject) {
    return (
      <ErrorBoundary onReset={() => setView('dashboard')}>
        <Workspace
          key={activeProject.id}
          project={activeProject}
          onProjectUpdated={(updated) => {
            setActiveProject(updated);
            setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
          }}
          onBackDashboard={() => {
            void refreshProjects().catch(() => {});
            setView('dashboard');
          }}
        />
      </ErrorBoundary>
    );
  }

  if (view === 'dashboard') {
    return (
      <ErrorBoundary onReset={() => setView('landing')}>
        <Dashboard
          user={user}
          demos={demos}
          projects={projects}
          onAuthChange={setUser}
          onRefreshProjects={refreshProjects}
          onOpenProject={(proj) => {
            setActiveProject(proj);
            setView('workspace');
          }}
          onBackHome={() => setView('landing')}
        />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <LandingPage
        demos={demos}
        onStartEditing={() => setView('dashboard')}
        onTryDemo={(demoId) => void handleTryDemo(demoId)}
      />
    </ErrorBoundary>
  );
}
