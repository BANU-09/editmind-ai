import { useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowRight,
  Check,
  Film,
  Layers,
  Play,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  Upload,
  Wand2,
} from 'lucide-react';
import type { DemoCatalogItem } from '../lib/api';
import { FALLBACK_DEMOS } from '../lib/fallbackData';
import { HeroOrbCanvas } from './HeroOrbCanvas';

interface LandingPageProps {
  demos: DemoCatalogItem[];
  onStartEditing: () => void;
  onTryDemo: (demoId?: string) => void;
}

const PROMPT_EXAMPLES = [
  {
    prompt: 'Remove the second mention of pricing.',
    result: 'Cut 00:36.2–00:42.8 · Preserved first pricing tier · -6.6s duration',
    segments: [
      { label: 'Intro', width: 22, status: 'keep' },
      { label: 'Benefit', width: 18, status: 'keep' },
      { label: 'Pricing #1', width: 16, status: 'keep' },
      { label: 'Live Demo', width: 20, status: 'keep' },
      { label: 'Pricing #2', width: 12, status: 'cut' },
      { label: 'CTA', width: 12, status: 'keep' },
    ],
  },
  {
    prompt: 'Remove unnecessary pauses.',
    result: 'Removed 4 silent gaps (-5.9s) · Recalculated word-synced captions',
    segments: [
      { label: 'Intro', width: 24, status: 'keep' },
      { label: '1.6s Pause', width: 10, status: 'cut' },
      { label: 'Demo', width: 28, status: 'keep' },
      { label: '1.8s Pause', width: 12, status: 'cut' },
      { label: 'CTA', width: 26, status: 'keep' },
    ],
  },
  {
    prompt: 'Move the conclusion to the beginning.',
    result: 'Reordered CTA to 00:00.0 · Captions and audio stayed attached',
    segments: [
      { label: 'CTA (Moved)', width: 20, status: 'accent' },
      { label: 'Intro', width: 24, status: 'keep' },
      { label: 'Pricing', width: 22, status: 'keep' },
      { label: 'Live Demo', width: 34, status: 'keep' },
    ],
  },
];

const VERSION_TABS = [
  {
    id: 'fast_hook',
    name: 'Fast Hook',
    duration: '00:28.4',
    pace: '1.15x Energetic',
    coverage: '48% Core Highlights',
    summary: 'Opens immediately with the live AI product demonstration, strips silent gaps, and lands on the free trial CTA.',
  },
  {
    id: 'balanced_story',
    name: 'Balanced Story',
    duration: '00:46.2',
    pace: '1.00x Natural',
    coverage: '78% Narrative Arc',
    summary: 'Keeps chronological flow, prunes redundant pricing mention and pauses, and retains every protected benefit.',
  },
  {
    id: 'detailed_explainer',
    name: 'Detailed Explainer',
    duration: '01:05.0',
    pace: '1.00x Complete',
    coverage: '100% Full Fidelity',
    summary: 'Preserves full explanations, technical disclaimers, and word-synced captions for deep-dive audiences.',
  },
];

const SEARCH_SAMPLE_HITS = [
  {
    time: '00:04.2',
    type: 'Spoken Phrase',
    speaker: 'Elena Vance',
    text: '...changing how teams edit video by meaning instead of scrubbing timelines.',
  },
  {
    time: '00:23.5',
    type: 'Demonstration',
    speaker: 'Elena Vance',
    text: 'Watch this live AI product demonstration. Type remove filler words...',
  },
  {
    time: '00:44.1',
    type: 'Scene Object',
    speaker: 'Visual Index',
    text: 'Stage projection screen · Keynote timeline graphic detected',
  },
];

export function LandingPage({ demos = [], onStartEditing, onTryDemo }: LandingPageProps) {
  const safeDemos = demos && demos.length > 0 ? demos : FALLBACK_DEMOS;
  const [activePromptIdx, setActivePromptIdx] = useState(0);
  const [activeVersionIdx, setActiveVersionIdx] = useState(1);
  const [searchFilter, setSearchFilter] = useState('AI');
  const [activeDemoId, setActiveDemoId] = useState<string>(safeDemos[0]?.id || 'demo-keynote');

  const currentPrompt = PROMPT_EXAMPLES[activePromptIdx];
  const currentVersion = VERSION_TABS[activeVersionIdx];
  const selectedDemo = safeDemos.find((d) => d.id === activeDemoId) || safeDemos[0] || FALLBACK_DEMOS[0];

  return (
    <div className="min-h-screen bg-[#050711] text-slate-100 overflow-x-hidden">
      {/* Subtle atmospheric lighting backdrop */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden"
      >
        <div className="absolute -top-40 left-1/4 h-[520px] w-[520px] rounded-full bg-cyan-500/12 blur-[140px]" />
        <div className="absolute top-1/3 -right-32 h-[480px] w-[480px] rounded-full bg-violet-600/14 blur-[150px]" />
        <div className="absolute bottom-0 left-1/3 h-[420px] w-[420px] rounded-full bg-pink-600/10 blur-[150px]" />
      </div>

      {/* 3-Zone Top Navigation Contract */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#050711]/95">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-8 px-6 py-4">
          <a
            href="#top"
            className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            EDITMIND <span className="bg-gradient-to-r from-cyan-400 via-violet-400 to-pink-400 bg-clip-text text-transparent">AI</span>
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-300">
            <a href="#features" className="hover:text-cyan-300 transition-colors whitespace-nowrap shrink-0">
              Features
            </a>
            <a href="#workflow" className="hover:text-cyan-300 transition-colors whitespace-nowrap shrink-0">
              Workflow
            </a>
            <a href="#preview" className="hover:text-cyan-300 transition-colors whitespace-nowrap shrink-0">
              Workspace
            </a>
            <a href="#demos" className="hover:text-cyan-300 transition-colors whitespace-nowrap shrink-0">
              Demos
            </a>
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={onStartEditing}
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 via-blue-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white hover:brightness-110 transition-all whitespace-nowrap shrink-0 cursor-pointer"
            >
              Start Editing
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section with 3D AI Orb */}
      <section id="top" className="relative mx-auto max-w-7xl px-6 pt-12 pb-16 lg:pt-16 lg:pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 items-center gap-10">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
            className="lg:col-span-6 space-y-6"
          >
            <p className="text-xs font-medium tracking-wider text-cyan-300">
              Semantic Video Editing · Real FFmpeg Export
            </p>
            <h1 className="text-4xl sm:text-5xl lg:text-[3.5rem] font-extrabold leading-[1.08] tracking-tight text-white [text-wrap:balance]">
              Edit Videos by{' '}
              <span className="bg-gradient-to-r from-cyan-300 via-violet-400 to-pink-400 bg-clip-text text-transparent">
                Meaning.
              </span>{' '}
              Not by Timeline.
            </h1>
            <p className="max-w-xl text-base sm:text-lg text-slate-300 leading-relaxed">
              Your footage. Your instructions. Intelligent editing. Search spoken moments, protect
              essential claims, generate multiple versions, and export real MP4 cuts in seconds.
            </p>

            <div className="flex flex-wrap items-center gap-4 pt-2">
              <button
                type="button"
                onClick={onStartEditing}
                className="inline-flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-cyan-500 via-blue-600 to-violet-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-cyan-500/20 hover:brightness-110 transition-all whitespace-nowrap cursor-pointer"
              >
                Start Editing
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => onTryDemo(demos[0]?.id)}
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-slate-900/80 px-6 py-3.5 text-sm font-semibold text-slate-100 hover:border-cyan-400/50 hover:text-cyan-200 transition-all whitespace-nowrap cursor-pointer"
              >
                <Play className="w-4 h-4 text-cyan-400" />
                Try Demo
              </button>
            </div>

            <div className="grid grid-cols-3 gap-4 pt-4 border-t border-white/10 max-w-lg">
              <div>
                <div className="text-xl font-bold font-mono tabular-nums text-cyan-300">5 Demos</div>
                <div className="text-xs text-slate-400">Real spoken MP4s</div>
              </div>
              <div>
                <div className="text-xl font-bold font-mono tabular-nums text-violet-300">5 Tracks</div>
                <div className="text-xs text-slate-400">Content-linked sync</div>
              </div>
              <div>
                <div className="text-xl font-bold font-mono tabular-nums text-pink-300">3 Versions</div>
                <div className="text-xs text-slate-400">One-click cuts</div>
              </div>
            </div>
          </motion.div>

          <div className="lg:col-span-6 relative h-[400px] sm:h-[460px] rounded-2xl border border-white/10 bg-[#080C1B]">
            <HeroOrbCanvas />
            {/* Clean non-blur bottom caption strip inside 3D frame */}
            <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-[#070B19]/95 px-4 py-2.5 text-xs">
              <span className="text-slate-300 truncate">
                Prompt: <span className="text-cyan-300 font-medium">"Remove the second mention of pricing"</span>
              </span>
              <span className="font-mono tabular-nums text-emerald-300 shrink-0">-6.6s Synced</span>
            </div>
          </div>
        </div>
      </section>

      {/* Sections 1-4: Core Capabilities & Three Signature Innovations */}
      <section id="features" className="mx-auto max-w-7xl px-6 py-16 space-y-14">
        <div className="max-w-2xl space-y-2">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Four Breakthrough Capabilities in One Studio
          </h2>
          <p className="text-sm sm:text-base text-slate-400">
            Every instruction passes through semantic retrieval, deterministic timeline mapping, and safety checks before touching your video.
          </p>
        </div>

        {/* Feature 1: Prompt-Based Video Editing */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 rounded-2xl border border-white/10 bg-[#0B1022]/90 p-6 sm:p-8 items-center">
          <div className="lg:col-span-5 space-y-4">
            <div className="inline-flex items-center gap-2 text-xs font-medium text-cyan-300">
              <Wand2 className="w-4 h-4" />
              01 · Prompt-Based Video Editing
            </div>
            <h3 className="text-xl sm:text-2xl font-bold text-white">
              Instruct the Edit in Plain English
            </h3>
            <p className="text-sm text-slate-300 leading-relaxed">
              Cut repeated points, strip dead air, accelerate introductions, restyle captions, or reorder chapters. Captions and audio stay locked to their spoken words automatically.
            </p>
            <div className="space-y-2 pt-2">
              {PROMPT_EXAMPLES.map((ex, idx) => (
                <button
                  key={ex.prompt}
                  type="button"
                  onClick={() => setActivePromptIdx(idx)}
                  className={`w-full text-left rounded-xl border px-3.5 py-2.5 text-xs transition-all cursor-pointer ${
                    activePromptIdx === idx
                      ? 'border-cyan-400/60 bg-cyan-500/10 text-cyan-200'
                      : 'border-white/10 bg-slate-900/60 text-slate-300 hover:border-white/25'
                  }`}
                >
                  "{ex.prompt}"
                </button>
              ))}
            </div>
          </div>

          <div className="lg:col-span-7 rounded-xl border border-white/10 bg-[#060914] p-5 space-y-4">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Deterministic Timeline Plan</span>
              <span className="font-mono text-emerald-300">{currentPrompt.result}</span>
            </div>
            <div className="flex items-center gap-1.5 h-16 rounded-lg bg-slate-950/90 p-2 border border-white/5">
              {currentPrompt.segments.map((seg, i) => (
                <div
                  key={`${seg.label}-${i}`}
                  style={{ width: `${seg.width}%` }}
                  className={`h-full rounded-md px-2 flex items-center justify-center text-[11px] font-medium truncate border ${
                    seg.status === 'cut'
                      ? 'border-rose-500/50 bg-rose-500/15 text-rose-300 line-through opacity-70'
                      : seg.status === 'accent'
                        ? 'border-violet-400/60 bg-violet-500/25 text-violet-100'
                        : 'border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
                  }`}
                >
                  {seg.label}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
              <span>Track 1: Video (Cyan)</span>
              <span>Track 2: Audio (Violet)</span>
              <span>Track 3: Captions (Emerald)</span>
            </div>
          </div>
        </div>

        {/* Features 2 & 3: Fast Content Search + Important Content Protection */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* 02. Fast Video Content Search */}
          <div className="rounded-2xl border border-white/10 bg-[#0B1022]/90 p-6 sm:p-7 space-y-5">
            <div className="inline-flex items-center gap-2 text-xs font-medium text-violet-300">
              <Search className="w-4 h-4" />
              02 · Fast Video Content Search
            </div>
            <h3 className="text-xl font-bold text-white">
              Jump Straight to Any Phrase, Speaker, or Object
            </h3>
            <p className="text-sm text-slate-300">
              Every uploaded or demo video is indexed once into a reusable semantic map covering spoken phrases, topics, speakers, objects, and activities.
            </p>
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#060914] px-3 py-2">
              <Search className="w-4 h-4 text-cyan-400 shrink-0" />
              <input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                aria-label="Preview video content search"
                placeholder="Search AI, pricing, stage..."
                className="w-full bg-transparent text-xs text-white focus:outline-none"
              />
            </div>
            <div className="space-y-2">
              {SEARCH_SAMPLE_HITS.filter((h) =>
                `${h.text} ${h.type} ${h.speaker}`.toLowerCase().includes(searchFilter.toLowerCase()),
              ).map((hit) => (
                <div
                  key={hit.time}
                  className="flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-slate-900/70 p-3 text-xs"
                >
                  <div className="space-y-1">
                    <div className="text-cyan-300 font-medium">
                      {hit.type} · {hit.speaker}
                    </div>
                    <div className="text-slate-300">{hit.text}</div>
                  </div>
                  <span className="font-mono tabular-nums text-violet-300 shrink-0">{hit.time}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 03. Important Content Protection */}
          <div className="rounded-2xl border border-white/10 bg-[#0B1022]/90 p-6 sm:p-7 space-y-5">
            <div className="inline-flex items-center gap-2 text-xs font-medium text-amber-300">
              <ShieldCheck className="w-4 h-4" />
              03 · Important Content Protection
            </div>
            <h3 className="text-xl font-bold text-white">
              Never Accidentally Cut a Disclaimer or CTA
            </h3>
            <p className="text-sm text-slate-300">
              EDITMIND AI flags key benefits, demonstrations, legal warnings, and CTAs—alerting you with exact source timestamps before destructive cuts execute.
            </p>
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-200">
                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                Protected Content Warning · Cut Blocked for Review
              </div>
              <div className="text-xs text-slate-200 space-y-1">
                <div>
                  Target: <span className="font-mono text-amber-300">00:54.0 – 01:05.0</span> (Closing CTA & Annual Billing Terms)
                </div>
                <div className="text-slate-300">
                  Reason: Removes required pricing disclaimer and free-trial call to action.
                </div>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => onTryDemo(safeDemos[0]?.id)}
                  className="rounded-lg bg-amber-500/20 border border-amber-400/50 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/30 transition-colors cursor-pointer"
                >
                  Inspect Protection in Studio
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Feature 4: Multiple Edit Version Generator */}
        <div className="rounded-2xl border border-white/10 bg-[#0B1022]/90 p-6 sm:p-8 space-y-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 text-xs font-medium text-pink-300">
                <Layers className="w-4 h-4" />
                04 · Multiple Edit Version Generator
              </div>
              <h3 className="text-xl sm:text-2xl font-bold text-white">
                Compare Three Genuinely Different Cuts Side by Side
              </h3>
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-[#060914] p-1">
              {VERSION_TABS.map((v, idx) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setActiveVersionIdx(idx)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    activeVersionIdx === idx
                      ? 'bg-gradient-to-r from-cyan-500/25 to-pink-500/25 text-white border border-cyan-400/40'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {v.name}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="rounded-xl border border-white/10 bg-[#060914] p-4">
              <div className="text-xs text-slate-400">Edited Duration</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-cyan-300 mt-1">
                {currentVersion.duration}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#060914] p-4">
              <div className="text-xs text-slate-400">Pacing Profile</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-violet-300 mt-1">
                {currentVersion.pace}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#060914] p-4">
              <div className="text-xs text-slate-400">Content Coverage</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-pink-300 mt-1">
                {currentVersion.coverage}
              </div>
            </div>
          </div>
          <p className="text-sm text-slate-300">{currentVersion.summary}</p>
        </div>
      </section>

      {/* Section 5: How It Works */}
      <section id="workflow" className="mx-auto max-w-7xl px-6 py-14">
        <div className="space-y-2 mb-8">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
            How It Works
          </h2>
          <p className="text-sm text-slate-400">
            Five deterministic stages from raw camera file to validated MP4 export.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {[
            { step: '01', title: 'Upload or Record', desc: 'Ingest MP4, WebM, MOV, or live camera & mic capture.', icon: Upload, color: 'text-cyan-400' },
            { step: '02', title: 'AI Analysis', desc: 'FFprobe metadata, silences, scenes, speakers, and transcript.', icon: Sparkles, color: 'text-blue-400' },
            { step: '03', title: 'Prompt Edit', desc: 'Write instructions; review impact and protected warnings.', icon: Wand2, color: 'text-violet-400' },
            { step: '04', title: 'Live Preview', desc: 'Scrub virtual multitrack timeline with synced captions.', icon: Sliders, color: 'text-emerald-400' },
            { step: '05', title: 'MP4 Export', desc: 'Server-side FFmpeg renders and validates your final cut.', icon: Film, color: 'text-pink-400' },
          ].map((item) => (
            <div
              key={item.step}
              className="rounded-2xl border border-white/10 bg-[#0B1022]/85 p-5 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-slate-400">{item.step}</span>
                <item.icon className={`w-4 h-4 ${item.color}`} />
              </div>
              <h3 className="text-base font-semibold text-white">{item.title}</h3>
              <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Section 6: Interactive Editor Preview */}
      <section id="preview" className="mx-auto max-w-7xl px-6 py-14">
        <div className="rounded-2xl border border-white/10 bg-[#090D1D] p-6 sm:p-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-white">Interactive Editing Workspace</h2>
              <p className="text-sm text-slate-400">
                Color-coded 5-track timeline, searchable transcript, live captions, and AI prompt assistant.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onTryDemo(safeDemos[0]?.id)}
              className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Open Full Workspace
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 rounded-xl border border-white/10 bg-[#050711] p-4">
            <div className="lg:col-span-3 rounded-lg border border-white/10 bg-[#0B1022] p-3 space-y-2 text-xs">
              <div className="font-semibold text-slate-200 pb-1 border-b border-white/10">
                Transcript · Scenes · Speakers
              </div>
              <div className="text-cyan-300 font-mono">00:00.0 · Elena Vance</div>
              <p className="text-slate-300">Welcome everyone to the NovaPulse AI launch keynote...</p>
              <div className="text-violet-300 font-mono pt-1">00:21.4 · Demonstration</div>
              <p className="text-slate-300">Now watch this live AI product demonstration...</p>
            </div>

            <div className="lg:col-span-6 rounded-lg border border-white/10 bg-black overflow-hidden relative aspect-video">
              {selectedDemo ? (
                <video
                  key={selectedDemo.id}
                  src={selectedDemo.mediaUrl}
                  poster={selectedDemo.thumbnailUrl}
                  controls
                  playsInline
                  className="w-full h-full object-cover"
                />
              ) : null}
            </div>

            <div className="lg:col-span-3 rounded-lg border border-white/10 bg-[#0B1022] p-3 flex flex-col justify-between gap-3 text-xs">
              <div className="space-y-2">
                <div className="font-semibold text-slate-200 pb-1 border-b border-white/10">
                  AI Assistant
                </div>
                <div className="rounded-lg bg-slate-900 p-2.5 text-slate-300">
                  Try clicking a demo video below or launch the studio to edit with natural language.
                </div>
              </div>
              <button
                type="button"
                onClick={() => onTryDemo(selectedDemo?.id || safeDemos[0]?.id)}
                className="w-full rounded-lg bg-gradient-to-r from-cyan-500 to-violet-600 py-2 text-xs font-semibold text-white hover:brightness-110 cursor-pointer"
              >
                Edit This Video Now
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Section 7: Real Demo Videos Library */}
      <section id="demos" className="mx-auto max-w-7xl px-6 py-14 space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="space-y-2">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
              Five Real Demo Projects Ready to Edit
            </h2>
            <p className="text-sm text-slate-400">
              Bundled MP4 videos with real speech narration, pauses, filler words, scenes, and transcripts.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {safeDemos.map((demo) => (
            <div
              key={demo.id}
              className="rounded-2xl border border-white/10 bg-[#0B1022]/90 overflow-hidden flex flex-col justify-between"
            >
              <div>
                <div className="relative aspect-video bg-slate-950">
                  <img
                    src={demo.thumbnailUrl}
                    alt={demo.title}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                  <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-xs">
                    <span className="text-cyan-300 font-medium">{demo.category}</span>
                    <span className="font-mono tabular-nums text-white">
                      {demo.durationSec.toFixed(1)}s
                    </span>
                  </div>
                </div>
                <div className="p-5 space-y-2.5">
                  <h3 className="text-base font-bold text-white">{demo.title}</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">{demo.description}</p>
                  <div className="text-[11px] text-slate-400 font-mono">
                    {demo.transcriptCount} segments · Sample: "{demo.examplePrompts[0]}"
                  </div>
                </div>
              </div>
              <div className="px-5 pb-5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setActiveDemoId(demo.id);
                    document.getElementById('preview')?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  className="flex-1 rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 hover:border-cyan-400/50 cursor-pointer"
                >
                  Preview
                </button>
                <button
                  type="button"
                  onClick={() => onTryDemo(demo.id)}
                  className="flex-1 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-3 py-2 text-xs font-semibold text-white hover:brightness-110 cursor-pointer"
                >
                  Edit in Studio
                </button>
              </div>
            </div>
          ))}

          {/* Balanced 6th Grid Card: Custom Upload & Live Recording */}
          <div className="rounded-2xl border border-dashed border-cyan-400/35 bg-gradient-to-br from-cyan-950/30 via-[#0B1022] to-violet-950/30 p-6 flex flex-col justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 text-xs font-medium text-cyan-300">
                <Upload className="w-4 h-4" />
                Your Own Media
              </div>
              <h3 className="text-lg font-bold text-white">Upload or Record Live Footage</h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                Drop any MP4, WebM, MOV, or MKV file—or capture directly from your camera & microphone. Every upload keeps its own unique media ID and dedicated FFprobe/AI analysis.
              </p>
              <div className="rounded-xl border border-white/10 bg-[#060914] p-3 text-[11px] font-mono text-slate-400 space-y-1">
                <div>• Unique Media ID preservation</div>
                <div>• Real FFmpeg silence & scene index</div>
                <div>• Word-level captions & MP4 export</div>
              </div>
            </div>
            <button
              type="button"
              onClick={onStartEditing}
              className="mt-5 w-full rounded-lg bg-gradient-to-r from-cyan-500 to-violet-600 px-3 py-2.5 text-xs font-semibold text-white hover:brightness-110 cursor-pointer"
            >
              Upload or Record Footage
            </button>
          </div>
        </div>
      </section>

      {/* Section 8: Final CTA & Footer */}
      <section className="mx-auto max-w-7xl px-6 py-16">
        <div className="rounded-2xl border border-cyan-400/25 bg-gradient-to-r from-cyan-950/50 via-indigo-950/50 to-fuchsia-950/50 p-8 sm:p-12 text-center space-y-5">
          <h2 className="text-2xl sm:text-4xl font-extrabold text-white [text-wrap:balance]">
            Ready to Edit Your Footage by Meaning?
          </h2>
          <p className="mx-auto max-w-xl text-sm sm:text-base text-slate-300">
            Jump straight in as a guest, upload your own video, record from your camera, or open any demo project right now.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
            <button
              type="button"
              onClick={onStartEditing}
              className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-bold text-slate-950 hover:bg-cyan-100 transition-colors cursor-pointer"
            >
              Open Project Dashboard
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => onTryDemo(demos[0]?.id)}
              className="inline-flex items-center gap-2 rounded-xl border border-white/25 bg-slate-950/70 px-6 py-3 text-sm font-semibold text-white hover:border-cyan-400 cursor-pointer"
            >
              <Check className="w-4 h-4 text-emerald-400" />
              Launch Keynote Demo
            </button>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 py-8 px-6">
        <div className="mx-auto flex max-w-7xl flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div>EDITMIND AI · Semantic Video Editing Platform</div>
          <div className="flex items-center gap-6">
            <a href="#features" className="hover:text-slate-300">Features</a>
            <a href="#workflow" className="hover:text-slate-300">How It Works</a>
            <a href="#demos" className="hover:text-slate-300">Demo Library</a>
            <button type="button" onClick={onStartEditing} className="hover:text-cyan-300 cursor-pointer">
              Enter Studio
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
