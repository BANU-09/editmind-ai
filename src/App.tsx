import { useCallback, useEffect, useState } from 'react';
import type { UserProfile } from './shared/types';
import { api, type DemoCatalogItem, type HydratedProject } from './lib/api';
import { LandingPage } from './components/LandingPage';
import { Dashboard } from './components/Dashboard';
import { Workspace } from './components/Workspace';

type ViewMode = 'landing' | 'dashboard' | 'workspace';

export default function App() {
  const [view, setView] = useState<ViewMode>('landing');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [demos, setDemos] = useState<DemoCatalogItem[]>([]);
  const [projects, setProjects] = useState<HydratedProject[]>([]);
  const [activeProject, setActiveProject] = useState<HydratedProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    const res = await api.listProjects();
    setProjects(res.projects);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const [meRes, demosRes, projRes] = await Promise.all([
          api.me().catch(() => ({ user: null })),
          api.listDemos(),
          api.listProjects().catch(() => ({ projects: [] })),
        ]);
        if (cancelled) return;
        setUser(meRes.user);
        setDemos(demosRes.demos);
        setProjects(projRes.projects);

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
      await refreshProjects();
    } catch (err) {
      setBootError(err instanceof Error ? err.message : 'Could not open demo project.');
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
            onClick={() => window.location.reload()}
            className="rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 cursor-pointer"
          >
            Reload Application
          </button>
        </div>
      </div>
    );
  }

  if (view === 'workspace' && activeProject) {
    return (
      <Workspace
        key={activeProject.id}
        project={activeProject}
        onProjectUpdated={(updated) => {
          setActiveProject(updated);
          setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        }}
        onBackDashboard={() => {
          void refreshProjects();
          setView('dashboard');
        }}
      />
    );
  }

  if (view === 'dashboard') {
    return (
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
    );
  }

  return (
    <LandingPage
      demos={demos}
      onStartEditing={() => setView('dashboard')}
      onTryDemo={(demoId) => void handleTryDemo(demoId)}
    />
  );
}
