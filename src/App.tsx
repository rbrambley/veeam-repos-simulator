import React, { useEffect, useMemo, useState } from 'react';
import { InputForm } from './components/InputForm';
import { OutputPanel } from './components/OutputPanel';
import { SimulationState } from './models/veeam';
import { VeeamSimulator } from './simulator/engine';

type ThemeMode = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'veeam-simulator-theme-mode';

function getStoredThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const todayDate = new Date().toISOString().slice(0, 10);

const defaultState: SimulationState = {
  repositories: [
    { id: 'repo1', name: 'Main Repo', type: 'DAS', capacityTB: 10 },
  ],
  jobs: [
    {
      id: 'job1',
      name: 'Daily Backup',
      type: 'ForwardIncremental',
      repositoryId: 'repo1',
      sourceDataTB: 1,
      dailyChangeRatePct: 5,
      annualGrowthRatePct: 0,
      forecastYears: 1,
      schedule: { frequency: 'Daily', timeOfDay: '02:00' },
      retention: { restorePoints: 14, slaDays: 14 },
    },
  ],
  chains: [],
  restorePoints: [],
  blocks: [],
  date: todayDate,
  startDate: todayDate,
};

export const App: React.FC = () => {
  const [simState, setSimState] = useState<SimulationState>({ ...defaultState });
  const [sim, setSim] = useState(() => new VeeamSimulator({ ...defaultState }));
  const [currentDate, setCurrentDate] = useState(defaultState.date);
  const [simulationStarted, setSimulationStarted] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(() => getSystemTheme());

  const resolvedTheme = useMemo(
    () => (themeMode === 'system' ? systemTheme : themeMode),
    [themeMode, systemTheme]
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handler);
      return () => media.removeEventListener('change', handler);
    }

    media.addListener(handler);
    return () => media.removeListener(handler);
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', resolvedTheme);
    }
  }, [resolvedTheme]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    }
  }, [themeMode]);

  const handleReset = () => {
    const today = new Date().toISOString().slice(0, 10);
    const fresh: SimulationState = { ...defaultState, date: today, startDate: today };
    setSimState({ ...fresh });
    setSim(new VeeamSimulator({ ...fresh }));
    setCurrentDate(today);
    setSimulationStarted(false);
    setResetKey(k => k + 1);
  };

  // Handler to update simulation state from InputForm
  const handleScenarioChange = (newState: SimulationState) => {
    setSimState({ ...newState });
    setSim(new VeeamSimulator({ ...newState }));
    setCurrentDate(newState.date);
    setSimulationStarted(true);
  };

  // Handler to advance simulation by N days
  const handleNextDay = (days: number = 1) => {
    const stepActivity: string[] = [];
    for (let i = 0; i < days; i++) {
      sim.nextDay();
      const dayActivity = sim.getDailyExplanation();
      if (dayActivity) {
        stepActivity.push(`[${sim.state.date}] ${dayActivity}`);
      }
    }

    // For multi-day jumps, surface all in-step activity so mid-step
    // copy/move/offload events are not lost from the panel.
    if (days > 1 && stepActivity.length > 0) {
      sim.lastDailyExplanation = stepActivity.join(' ');
    }

    setSim(sim); // force update
    setCurrentDate(sim.state.date);
  };

  return (
    <div className="app-container">
      <div className="app-header-row">
        <h1>Veeam Backup Simulator</h1>
        <div className="theme-toggle" role="group" aria-label="Theme selection">
          {(['light', 'dark', 'system'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              className={`theme-toggle-btn${themeMode === mode ? ' active' : ''}`}
              onClick={() => setThemeMode(mode)}
            >
              {mode[0].toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <InputForm
        key={resetKey}
        simState={simState}
        onScenarioChange={handleScenarioChange}
        onReset={handleReset}
      />
      <hr />
      {simulationStarted && (
        <OutputPanel
          sim={sim}
          currentDate={currentDate}
          onNextDay={handleNextDay}
        />
      )}
    </div>
  );
};

export default App;
