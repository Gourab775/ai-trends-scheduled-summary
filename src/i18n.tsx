import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type Locale = 'en';

const translations = {
  en: {
    // Header
    eyebrow: 'AI Trends Monitor',
    title: 'AI Trends Summary',
    subtitle: 'Automatically crawl, curate, and summarize AI industry news into traceable trend reports.',
    scheduleHint: 'Daily at 1:00 UTC',
    generate: 'Generate',
    generating: 'Generating...',
    stop: 'Stop',

    // Stats bar
    lastGenerated: 'Last generated',
    items: 'items',
    topics: 'topics',
    source: 'Sources',

    // Pipeline
    stageFetch: 'Fetch',
    stageFilter: 'Filter & Summarize',
    stageAnalyze: 'Analyze',
    stageWrite: 'Write',

    // Live phase hints
    phaseIdle: 'Preparing...',
    phaseFetched: 'Collected candidates, filtering & summarizing...',
    phaseCurated: 'Filtered valuable content, generating summaries...',
    phaseSummarized: 'Summaries done, analyzing trends...',
    phaseAnalyzed: 'Analysis complete, writing final report...',
    phaseWriting: 'Writing report, almost done...',
    phaseDone: 'Report ready',

    // Feed
    feedLabel: 'News Feed',
    feedTitle: 'News Feed',
    refresh: 'Refresh',
    newItems: 'New Items',
    recurring: 'Ongoing',
    emptyFeed: 'No items yet. Click "Generate" to start.',
    noNewBanner: 'No new AI trends found this time. Here are recent items still worth noting.',
    sourceLabel: 'Source',
    score: 'score',

    // Sidebar
    reportsLabel: 'Trend Reports',
    reportsTitle: 'Reports',
    reportCount: '',
    latest: 'Latest',
    viewReport: 'View full report',
    noSummary: 'No summary',
    noHistory: 'No report history',
    noHistoryHint: 'Reports will appear here after generation',
    deleteReport: 'Delete report',
    confirmDelete: 'Delete this report?',

    // Trigger badge
    triggerSchedule: 'Scheduled',
    triggerManual: 'Manual',

    // Status
    statusEmpty: 'Pending',
    statusRunning: 'Running',
    statusSuccess: 'Done',
    statusFailed: 'Failed',

    // Time
    noTime: 'Not generated',
    unknownTime: 'Unknown',

    // Mini typing card
    writingReport: 'Writing report',
    chars: 'chars',
    expandClick: 'Click to expand →',

    // Drawer
    liveWriting: 'Live Writing',
    fullReport: 'Full Report',
    writingTitle: 'Writing report...',
    reportTitle: 'Trend Report',

    // Onboarding
    onboardingTitle: 'Generate Your First AI Trend Report',
    onboardingDesc: 'Aggregate the latest AI news from Hacker News, Dev.to, 36kr and more through a 4-step Agent pipeline (Collect → Curate → Summarize → Analyze) into a traceable trend report.',
    onboardingFeature1: 'Multi-source',
    onboardingFeature2: 'Smart Clustering',
    onboardingFeature3: 'Continuous Tracking',
    onboardingCta: 'Generate first report',
    onboardingGenerating: 'Generating...',

    // Drawer extras
    liveTag: 'Live generating',
    drawerLoading: 'Loading report...',
    reportItems: 'items',
    reportNew: 'new',
    noMoreHistory: 'No more history',
    close: 'Close',

    // Live phase tags
    phaseTagFetched: 'Fetched',
    phaseTagCurated: 'Curated',
    phaseTagSummarized: 'Summarized',
    otherCategory: 'Other',
    unknownTimeLabel: 'Unknown',
    fallbackSummary: 'update',

    // Deploy FAB
    deployButton: 'Deploy',
    deployDesc: 'Deploy your own AI trend monitor with {link} — lightning-fast global CDN, completely free.',
    deployLink: 'EdgeOne Makers',
  },
} as const;

export type TranslationKey = keyof typeof translations['en'];

const I18nContext = createContext<{
  locale: Locale;
  t: (key: TranslationKey) => string;
  toggleLocale: () => void;
}>({
  locale: 'en',
  t: (key) => translations.en[key],
  toggleLocale: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale] = useState<Locale>('en');

  const toggleLocale = useCallback(() => {}, []);

  const t = useCallback((key: TranslationKey): string => {
    return translations[locale][key] ?? key;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, t, toggleLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
